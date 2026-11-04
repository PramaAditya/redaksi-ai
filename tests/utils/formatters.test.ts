import { describe, it, expect } from 'vitest';
import { formatQueueConfirmation } from '../../src/utils/formatters.js';

describe('formatQueueConfirmation', () => {
  it('should format queue confirmation with hero image attached and Dark Dramatize style', () => {
    const result = formatQueueConfirmation({
      hasImage: true,
      heroStyle: 'Dark-Dramatize',
      accountName: 'poros.perjuangan',
    });

    expect(result).toBe([
      '✅ <b>Masuk antrean sistem</b>',
      '',
      '- <b>Hero Image Attached:</b> ✔️',
      '- <b>Hero Image Style:</b> Dark Dramatize',
      '- <b>Account:</b> poros.perjuangan',
    ].join('\n'));
  });

  it('should format queue confirmation with no hero image attached and 4K Realistic style', () => {
    const result = formatQueueConfirmation({
      hasImage: false,
      heroStyle: '4K-Enhance',
      accountName: 'poros.perjuangan',
    });

    expect(result).toBe([
      '✅ <b>Masuk antrean sistem</b>',
      '',
      '- <b>Hero Image Attached:</b> ❌',
      '- <b>Hero Image Style:</b> 4K Realistic',
      '- <b>Account:</b> poros.perjuangan',
    ].join('\n'));
  });

  it('should fallback to poros.perjuangan if accountName is omitted', () => {
    const result = formatQueueConfirmation({
      hasImage: true,
      heroStyle: 'Dark-Dramatize',
    });

    expect(result).toContain('- <b>Account:</b> poros.perjuangan');
  });
});
