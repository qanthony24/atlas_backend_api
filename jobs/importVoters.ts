import { Pool } from 'pg';
import crypto from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { cleanLouisianaHeader, parseCSVLine } from '../utils/csvParser';
import { getObjectBody } from '../storage';
import { config } from '../config';
import { xlsxBufferToCsv } from '../utils/xlsxToCsv';

export interface ImportJobPayload {
    jobId: string;
    orgId: string;
    userId: string;
    voters?: Array<Record<string, any>>;
    fileKey?: string;
}

const mapHeaderToField = (header: string): string | null => {
    const h = header.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Stable external voter id (required for upsert)
    if (
        [
            'REGISTRATIONNUMBER',
            'REGISTRATIONNUM',
            'REGNUMBER',
            'VOTERID',
            'STATEVOTERID',
            'STATEID',
            'VANID',
            'EXTERNALID',
            'ID',
            'LALISTID',
        ].includes(h)
    )
        return 'external_id';

    // Names
    if (['FIRSTNAME', 'NAMEFIRST', 'FNAME', 'FIRST'].includes(h)) return 'first_name';
    if (['LASTNAME', 'NAMELAST', 'LNAME', 'LAST'].includes(h)) return 'last_name';
    if (['MIDDLENAME', 'NAMEMID', 'MNAME', 'MID', 'MI'].includes(h)) return 'middle_name';
    if (['SUFFIX', 'NAMESUFFIX', 'PERSONALNAMESUFFIX', 'SFX'].includes(h)) return 'suffix';

    // Demographics
    if (['AGE', 'BIRTHYEAR', 'DOB'].includes(h)) return 'age';
    if (['GENDER', 'SEX', 'PERSONALSEX'].includes(h)) return 'gender';
    if (['RACE', 'ETHNICITY', 'PERSONALRACE'].includes(h)) return 'race';
    if (['PARTY', 'PARTYID', 'POLITICALPARTY', 'PARTYAFFILIATION', 'REGISTRATIONPOLITICALPARTYCODE'].includes(h)) return 'party';

    // Phone
    if (h.includes('PHONE') || h.includes('MOBILE') || h.includes('CELL')) return 'phone';

    // Address fields (Louisiana exports often split these)
    if (['RESIDENCEHOUSENUMBER'].includes(h)) return 'res_house_number';
    if (['RESIDENCEHOUSEFRACTION'].includes(h)) return 'res_house_fraction';
    if (['RESIDENCESTREETDIRECTION'].includes(h)) return 'res_street_direction';
    if (['RESIDENCESTREETNAME'].includes(h)) return 'res_street_name';

    if (['ADDRESS', 'RESADDRESS1', 'STREETADDRESS', 'ADDR1', 'RESIDENCEADDRESS', 'STREET', 'ADDRESS1', 'RESIDENCEADDRESSLINE1'].includes(h)) return 'address';
    if (['UNIT', 'APT', 'APARTMENT', 'SUITE', 'ADDRESS2', 'RESADDRESS2', 'ADDR2', 'RESADDRESSLINE2', 'RESIDENCEAPARTMENTNUMBER'].includes(h)) return 'unit';
    if (['CITY', 'RESCITY', 'RESIDENCECITY', 'RESIDENCECITYNAME'].includes(h)) return 'city';
    if (['STATE', 'RESSTATE', 'ST', 'RESIDENCESTATE'].includes(h)) return 'state';
    if (['ZIP', 'ZIPCODE', 'RESZIP', 'POSTALCODE', 'ZIP5', 'RESIDENCEZIPCODE5'].includes(h)) return 'zip';

    return null;
};

const parseCsvToVoters = (csv: string): Array<Record<string, any>> => {
    const lines = csv.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];
    const rawHeaders = parseCSVLine(lines[0]);
    const cleanedHeaders = rawHeaders.map(cleanLouisianaHeader);
    const fieldMap = cleanedHeaders.map(h => mapHeaderToField(h));
    const voters: Array<Record<string, any>> = [];

    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const row: Record<string, any> = {};
        fieldMap.forEach((field, idx) => {
            if (!field) return;
            row[field] = values[idx];
        });
        voters.push(row);
    }
    return voters;
};

export const processImportJob = async (
    pool: Pool,
    s3Client: S3Client | null,
    payload: ImportJobPayload
) => {
    const { jobId, orgId, userId, voters, fileKey } = payload;
    const startedAt = new Date().toISOString();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `
            UPDATE import_jobs
               SET status = 'processing',
                   updated_at = NOW(),
                   metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{progress}', $3::jsonb, true)
             WHERE id = $1 AND org_id = $2
            `,
            [jobId, orgId, { started_at: startedAt, phase: 'starting', processed_rows: 0, total_rows: null }]
        );
        await client.query(
            `INSERT INTO platform_events (org_id, user_id, event_type, metadata)
             VALUES ($1, $2, 'import.started', $3)`,
            [orgId, userId, { job_id: jobId }]
        );

        let rows: Array<Record<string, any>> = voters || [];
        if (fileKey && s3Client) {
            await client.query(
                `
                UPDATE import_jobs
                   SET updated_at = NOW(),
                       metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{progress}', $3::jsonb, true)
                 WHERE id = $1 AND org_id = $2
                `,
                [jobId, orgId, { started_at: startedAt, phase: 'reading_file', processed_rows: 0, total_rows: null }]
            );

            const body = await getObjectBody(s3Client, config.s3Bucket, fileKey);

            // Support both CSV and XLSX uploads. XLSX is converted to CSV in the worker (python3 + openpyxl)
            // and then processed by the existing CSV mapping pipeline.
            const lower = String(fileKey).toLowerCase();
            const csvBuffer = lower.endsWith('.xlsx') ? await xlsxBufferToCsv(body) : body;

            await client.query(
                `
                UPDATE import_jobs
                   SET updated_at = NOW(),
                       metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{progress}', $3::jsonb, true)
                 WHERE id = $1 AND org_id = $2
                `,
                [jobId, orgId, { started_at: startedAt, phase: 'parsing_rows', processed_rows: 0, total_rows: null }]
            );

            rows = parseCsvToVoters(csvBuffer.toString('utf-8'));
        }

        const totalRows = rows.length;
        await client.query(
            `
            UPDATE import_jobs
               SET updated_at = NOW(),
                   metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{progress}', $3::jsonb, true)
             WHERE id = $1 AND org_id = $2
            `,
            [jobId, orgId, { started_at: startedAt, phase: 'writing_voters', processed_rows: 0, total_rows: totalRows }]
        );

        let importedCount = 0;
        let skippedMissingExternalId = 0;
        for (const row of rows) {
            // External ID is required for stable upserts. If we can't map it, skip the row.
            const externalId = row.external_id || row.externalId;
            if (!externalId || String(externalId).trim() === '') {
                skippedMissingExternalId++;
                continue;
            }

            const firstName = row.first_name || row.firstName || 'Unknown';
            const lastName = row.last_name || row.lastName || 'Unknown';

            // Compose residence address if the file provides split components.
            // (Most LA exports split house number + street name.)
            const composedAddress = [
                row.res_house_number,
                row.res_house_fraction,
                row.res_street_direction,
                row.res_street_name,
            ]
                .map((x: any) => String(x || '').trim())
                .filter((x: string) => x.length > 0)
                .join(' ');

            const address = (row.address && String(row.address).trim()) || composedAddress || 'Unknown';
            const city = row.city || 'Unknown';
            const zip = row.zip || '';

            await client.query(
                `INSERT INTO voters (
                    org_id, external_id, first_name, middle_name, last_name, suffix,
                    age, gender, race, party, phone, address, unit, city, state, zip,
                    geom_lat, geom_lng, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                    $17, $18, NOW()
                )
                ON CONFLICT (org_id, external_id) DO UPDATE SET
                    first_name = EXCLUDED.first_name,
                    middle_name = EXCLUDED.middle_name,
                    last_name = EXCLUDED.last_name,
                    suffix = EXCLUDED.suffix,
                    age = EXCLUDED.age,
                    gender = EXCLUDED.gender,
                    race = EXCLUDED.race,
                    party = EXCLUDED.party,
                    phone = EXCLUDED.phone,
                    address = EXCLUDED.address,
                    unit = EXCLUDED.unit,
                    city = EXCLUDED.city,
                    state = EXCLUDED.state,
                    zip = EXCLUDED.zip,
                    geom_lat = EXCLUDED.geom_lat,
                    geom_lng = EXCLUDED.geom_lng,
                    updated_at = NOW()`,
                [
                    orgId,
                    externalId,
                    firstName,
                    row.middle_name || row.middleName || null,
                    lastName,
                    row.suffix || null,
                    row.age ? Number(row.age) : null,
                    row.gender || null,
                    row.race || null,
                    row.party || null,
                    row.phone || null,
                    address,
                    row.unit || null,
                    city,
                    row.state || 'LA',
                    zip,
                    row.geom_lat || row.geomLat || 40.7128 + Math.random() * 0.01,
                    row.geom_lng || row.geomLng || -74.006 + Math.random() * 0.01
                ]
            );
            importedCount++;

            // Emit progress every N rows to keep UI responsive without hammering Postgres.
            if (importedCount % 250 === 0) {
                await client.query(
                    `
                    UPDATE import_jobs
                       SET updated_at = NOW(),
                           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{progress}', $3::jsonb, true)
                     WHERE id = $1 AND org_id = $2
                    `,
                    [jobId, orgId, { started_at: startedAt, phase: 'writing_voters', processed_rows: importedCount, total_rows: totalRows }]
                );
            }
        }

        // Final progress update (100%) before marking completed
        await client.query(
            `
            UPDATE import_jobs
               SET updated_at = NOW(),
                   metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{progress}', $3::jsonb, true)
             WHERE id = $1 AND org_id = $2
            `,
            [jobId, orgId, { started_at: startedAt, phase: 'finalizing', processed_rows: importedCount, total_rows: totalRows }]
        );

        await client.query(
            `UPDATE import_jobs
             SET status = 'completed', updated_at = NOW(), result = $1
             WHERE id = $2 AND org_id = $3`,
            [{ imported_count: importedCount, skipped_missing_external_id: skippedMissingExternalId, total_rows: totalRows }, jobId, orgId]
        );
        await client.query(
            `INSERT INTO platform_events (org_id, user_id, event_type, metadata)
             VALUES ($1, $2, 'import.completed', $3)`,
            [orgId, userId, { job_id: jobId, count: importedCount, skipped_missing_external_id: skippedMissingExternalId, total_rows: totalRows }]
        );
        await client.query(
            `INSERT INTO audit_logs (action, actor_user_id, target_org_id, metadata)
             VALUES ('import.success', $1, $2, $3)`,
            [userId, orgId, { job_id: jobId, count: importedCount }]
        );

        await client.query('COMMIT');
        return { importedCount };
    } catch (error: any) {
        await client.query('ROLLBACK');
        await client.query(
            `UPDATE import_jobs
             SET status = 'failed', updated_at = NOW(), error = $1
             WHERE id = $2 AND org_id = $3`,
            [error.message, jobId, orgId]
        );
        await client.query(
            `INSERT INTO platform_events (org_id, user_id, event_type, metadata)
             VALUES ($1, $2, 'import.failed', $3)`,
            [orgId, userId, { job_id: jobId, error: error.message }]
        );
        throw error;
    } finally {
        client.release();
    }
};
