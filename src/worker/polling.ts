import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { queueTable } from '../db/schema.js';
import { getBufferPostStatus as defaultGetBufferPostStatus } from '../buffer.js';
import { getConnections as defaultGetConnections } from '../db/settings.js';

export interface PollBufferingOptions {
  db?: any;
  telegram?: any;
  getBufferPostStatus?: (bufferToken: string, bufferPostId: string) => Promise<any>;
  getConnections?: () => Promise<any[]>;
  maxRetries?: number;
  adminChatId?: string;
}

export async function pollBufferingPosts(options: PollBufferingOptions = {}) {
  const db = options.db || defaultDb;
  const telegram = options.telegram;
  const getBufferPostStatus = options.getBufferPostStatus || defaultGetBufferPostStatus;
  const getConnections = options.getConnections || defaultGetConnections;
  const maxRetries = options.maxRetries ?? 3;
  const adminChatId = options.adminChatId || process.env.TELEGRAM_ADMIN_CHAT_ID;

  try {
    const bufferingPosts = await db
      .select()
      .from(queueTable)
      .where(sql`status = 'buffering' AND buffer_post_id IS NOT NULL`);

    if (!bufferingPosts || bufferingPosts.length === 0) {
      return;
    }

    const connections = await getConnections();

    for (const post of bufferingPosts) {
      try {
        const connection = connections.find((c: any) => c.id === post.connectionId);
        if (!connection || !connection.bufferApiKey) {
          console.warn(`[Polling] Connection or Buffer API key missing for post ID ${post.id}`);
          continue;
        }

        const statusResult = await getBufferPostStatus(connection.bufferApiKey, post.bufferPostId);

        // Case 1: Successfully published to Instagram
        if (statusResult.status === 'sent' && statusResult.externalLink) {
          console.log(`[Polling] Post ID ${post.id} sent successfully! URL: ${statusResult.externalLink}`);

          await db.update(queueTable)
            .set({
              status: 'published',
              postUrl: statusResult.externalLink,
              publishedAt: new Date(),
            })
            .where(eq(queueTable.id, post.id));

          const isDirectReply = Boolean(post.chatId && /^-?\d+$/.test(String(post.chatId)));
          const targetChatId = isDirectReply ? post.chatId : adminChatId;

          if (telegram && targetChatId) {
            const titleSnippet = post.text
              ? post.text.split('\n')[0].replace(/[*#_`]/g, '').slice(0, 100)
              : 'Postingan Baru';

            const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            const sourceTag = isDirectReply ? '' : ' <i>(via Dashboard)</i>';
            const message = `🎉 <b>Postingan Berhasil Terbit di Instagram!</b>${sourceTag}\n\n📌 <b>Konten:</b> ${titleSnippet}\n🕒 <b>Waktu:</b> ${timeStr} WIB`;

            try {
              await telegram.sendMessage(targetChatId, message, {
                reply_to_message_id: isDirectReply && post.messageId ? Number(post.messageId) : undefined,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🔗 Buka Postingan Instagram',
                        url: statusResult.externalLink,
                      }
                    ]
                  ]
                }
              });
            } catch (teleErr) {
              console.error(`[Polling] Failed to send Telegram success notification for post ID ${post.id}:`, teleErr);
            }
          }
        } else if (statusResult.status === 'error') {
          // Case 2: Buffer / Instagram returned error
          const currentRetries = post.retryCount || 0;

          if (currentRetries < maxRetries) {
            // Schedule auto-retry with exponential backoff (2m, 4m, 8m)
            const delayMinutes = Math.pow(2, currentRetries + 1);
            const nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000);

            console.warn(`[Polling] Post ID ${post.id} failed on Buffer. Scheduling retry #${currentRetries + 1} at ${nextRetryAt.toISOString()}`);

            await db.update(queueTable)
              .set({
                status: 'pending',
                retryCount: currentRetries + 1,
                nextRetryAt,
                errorLog: statusResult.message || 'Buffer publishing error (auto-retry scheduled)',
              })
              .where(eq(queueTable.id, post.id));
          } else {
            // Retries exhausted
            console.error(`[Polling] Post ID ${post.id} failed permanently after ${currentRetries} retries.`);

            await db.update(queueTable)
              .set({
                status: 'error',
                errorLog: statusResult.message || 'Persistent media upload failure (retries exhausted)',
              })
              .where(eq(queueTable.id, post.id));

            const isDirectReply = Boolean(post.chatId && /^-?\d+$/.test(String(post.chatId)));
            const targetChatId = isDirectReply ? post.chatId : adminChatId;

            if (telegram && targetChatId) {
              const errorMessage = `❌ <b>Postingan Gagal Terbit di Instagram</b>\n\nAlasan: ${statusResult.message || 'Persistent media upload failure'}`;
              try {
                await telegram.sendMessage(targetChatId, errorMessage, {
                  reply_to_message_id: isDirectReply && post.messageId ? Number(post.messageId) : undefined,
                  parse_mode: 'HTML',
                });
              } catch (teleErr) {
                console.error(`[Polling] Failed to send Telegram error notification for post ID ${post.id}:`, teleErr);
              }
            }
          }
        }
        // Case 3: 'sending' -> Leave in 'buffering'
      } catch (postErr: any) {
        console.error(`[Polling] Error checking Buffer status for post ID ${post.id}:`, postErr.message || postErr);
      }
    }
  } catch (err: any) {
    console.error('[Polling] Error in pollBufferingPosts:', err.message || err);
  }
}
