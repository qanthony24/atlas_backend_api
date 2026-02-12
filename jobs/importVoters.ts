import { Pool } from 'pg';
import crypto from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { cleanLouisianaHeader, parseCSVLine } from '../../utils/csvParser';
import { getObjectBody } from '../storage';
import { config } from '../config';

export interface ImportJobPayload {
    jobId: string;
    orgId: string;
    userId: string;
    voters?: Array<Record<string, any>>;
    fileKey?: string;
}

const mapHeaderToField = (header: string): string | null => {
    const h = header.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (['REGNUMBER', 'VOTERID', 'STATEID', 'VANID', 'EXTERNALID', 'ID', 'LALISTID'].includes(h)) return 'external_id';
    if (['FIRSTNAME', 'NAMEFIRST', 'FNAME', 'FIRST'].includes(h)) return 'first_name';
    if (['LASTNAME', 'NAMELAST', 'LNAME', 'LAST'].includes(h)) return 'last_name';
    if (['MIDDLENAME', 'NAMEMID', 'MNAME', 'MID', 'MI'].includes(h)) return 'middle_name';
    if (['SUFFIX', 'NAMESUFFIX', 'SFX'].includes(h)) return 'suffix';
    if (['AGE', 'BIRTHYEAR', 'DOB'].includes(h)) return 'age';
    if (['GENDER', 'SEX'].includes(h)) return 'gender';
    if (['RACE', 'ETHNICITY'].includes(h)) return 'race';
    if (h.includes('PHONE') || h.includes('MOBILE') || h.includes('CELL')) return 'phone';
    if (['ADDRESS', 'RESADDRESS1', 'STREETADDRESS', 'ADDR1', 'RESIDENCEADDRESS', 'STREET', 'ADDRESS1'].includes(h)) return 'address';
    if (['UNIT', 'APT', 'APARTMENT', 'SUITE', 'ADDRESS2', 'RESADDRESS2', 'ADDR2', 'RESADDRESSLINE2'].includes(h)) return 'unit';
    if (['CITY', 'RESCITY', 'RESIDENCECITY'].includes(h)) return 'city';
    if (['STATE', 'RESSTATE', 'ST'].includes(h)) return 'state';
    if (['ZIP', 'ZIPCODE', 'RESZIP', 'POSTALCODE', 'ZIP5'].includes(h)) return 'zip';
    if (['PARTY', 'PARTYID', 'POLITICALPARTY', 'PARTYAFFILIATION'].includes(h)) return 'party';
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
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE import_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
            [jobId, orgId]
        );
        await client.query(
            `INSERT INTO platform_events (org_id, user_id, event_type, metadata)
             VALUES ($1, $2, 'import.started', $3)`,
            [orgId, userId, { job_id: jobId }]
        );

        let rows: Array<Record<string, any>> = voters || [];
        if (fileKey && s3Client) {
            const body = await getObjectBody(s3Client, config.s3Bucket, fileKey);
            rows = parseCsvToVoters(body.toString('utf-8'));
        }

        let importedCount = 0;
        for (const row of rows) {
            const externalId = row.external_id || row.externalId || `IMP-${crypto.randomUUID()}`;
            const firstName = row.first_name || row.firstName || 'Unknown';
            const lastName = row.last_name || row.lastName || 'Unknown';
            const address = row.address || 'Unknown';
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
        }

        await client.query(
            `UPDATE import_jobs
             SET status = 'completed', updated_at = NOW(), result = $1
             WHERE id = $2 AND org_id = $3`,
            [{ imported_count: importedCount }, jobId, orgId]
        );
        await client.query(
            `INSERT INTO platform_events (org_id, user_id, event_type, metadata)
             VALUES ($1, $2, 'import.completed', $3)`,
            [orgId, userId, { job_id: jobId, count: importedCount }]
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
