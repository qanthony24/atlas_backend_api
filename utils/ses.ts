import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config';

export function canUseSesApi(): boolean {
  return !!(config.awsAccessKeyId && config.awsSecretAccessKey && config.awsRegion);
}

export async function sendEmailViaSes(params: {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ messageId?: string }> {
  const client = new SESv2Client({
    region: config.awsRegion,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
  });

  const cmd = new SendEmailCommand({
    FromEmailAddress: params.from,
    Destination: {
      ToAddresses: [params.to],
    },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: params.text, Charset: 'UTF-8' },
          Html: { Data: params.html, Charset: 'UTF-8' },
        },
      },
    },
  });

  const res = await client.send(cmd);
  return { messageId: res.MessageId };
}
