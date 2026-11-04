export interface QueueConfirmationParams {
  hasImage?: boolean;
  heroStyle?: string;
  accountName?: string;
  templateId?: string;
}

/**
 * Formats the queue entry confirmation message for Telegram bot
 * with detailed parameters including image attachment status, style, and account name.
 */
export function formatQueueConfirmation(params: QueueConfirmationParams): string {
  const account = params.accountName || 'poros.perjuangan';

  const attached = params.hasImage ? '✔️' : '❌';
  const style = params.heroStyle === 'Dark-Dramatize' ? 'Dark Dramatize' : '4K Realistic';

  return [
    '✅ <b>Masuk antrean sistem</b>',
    '',
    `- <b>Hero Image Attached:</b> ${attached}`,
    `- <b>Hero Image Style:</b> ${style}`,
    `- <b>Account:</b> ${account}`,
  ].join('\n');
}
