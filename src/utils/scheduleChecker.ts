import { eq, sql, asc } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { queueTable } from '../db/schema.js';
import { getConnection as defaultGetConnection } from '../db/settings.js';

export interface UpcomingScheduleResult {
  hasUpcoming: boolean;
  type?: 'scheduled_post' | 'auto_slot';
  minutesRemaining?: number;
  timeStr?: string;
  upcomingPostId?: number | null;
  upcomingPostTitle?: string | null;
  upcomingSlotDay?: string;
}

export async function checkUpcomingSchedule({
  db = defaultDb,
  postId,
  getConnectionFn = defaultGetConnection,
  referenceTime = new Date()
}: {
  db?: any;
  postId: number;
  getConnectionFn?: (id: number) => Promise<any>;
  referenceTime?: Date;
}): Promise<UpcomingScheduleResult> {
  try {
    // 1. Fetch current post
    const [currentPost] = await db.select().from(queueTable).where(eq(queueTable.id, postId)).limit(1);
    if (!currentPost || !currentPost.connectionId) {
      return { hasUpcoming: false };
    }

    const connection = await getConnectionFn(currentPost.connectionId);
    if (!connection) {
      return { hasUpcoming: false };
    }

    const oneHourLater = new Date(referenceTime.getTime() + 60 * 60 * 1000);

    // 2. Check for upcoming custom scheduled posts within the next 60 minutes
    const upcomingScheduledPosts = await db
      .select()
      .from(queueTable)
      .where(sql`
        connection_id = ${currentPost.connectionId}
        AND id != ${postId}
        AND status = 'pending'
        AND scheduled_at IS NOT NULL
        AND scheduled_at > ${referenceTime}
        AND scheduled_at <= ${oneHourLater}
      `)
      .orderBy(asc(queueTable.scheduledAt))
      .limit(1);

    if (upcomingScheduledPosts && upcomingScheduledPosts.length > 0) {
      const scheduledPost = upcomingScheduledPosts[0];
      const diffMs = new Date(scheduledPost.scheduledAt).getTime() - referenceTime.getTime();
      const minutesRemaining = Math.max(1, Math.round(diffMs / 60000));
      const timeStr = new Intl.DateTimeFormat('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'Asia/Jakarta'
      }).format(new Date(scheduledPost.scheduledAt));

      return {
        hasUpcoming: true,
        type: 'scheduled_post',
        minutesRemaining,
        timeStr,
        upcomingPostId: scheduledPost.id,
        upcomingPostTitle: scheduledPost.text?.split('\n')[0]?.replace(/[*#_`]/g, '')?.slice(0, 100) || null,
      };
    }

    // 3. Check for upcoming auto-slots within the next 60 minutes
    if (connection.postingSlots && Array.isArray(connection.postingSlots)) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: 'Asia/Jakarta'
      });
      const currentDay = formatter.format(referenceTime).toLowerCase();
      const tomorrowDate = new Date(referenceTime.getTime() + 24 * 60 * 60 * 1000);
      const tomorrowDay = formatter.format(tomorrowDate).toLowerCase();

      // Convert referenceTime to minutes since midnight in Asia/Jakarta
      const timeFormatter = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23',
        timeZone: 'Asia/Jakarta'
      });
      const timeParts = timeFormatter.formatToParts(referenceTime);
      const currentHour = parseInt(timeParts.find(p => p.type === 'hour')?.value || '0', 10);
      const currentMin = parseInt(timeParts.find(p => p.type === 'minute')?.value || '0', 10);
      const currentTotalMins = currentHour * 60 + currentMin;

      const computeMinutesUntilSlot = (slot: { day: string; time: string }): number | null => {
        const slotDay = slot.day.toLowerCase();
        const [sHour, sMin] = slot.time.split(':').map(Number);
        const slotTotalMins = sHour * 60 + sMin;
        if (slotDay === currentDay) {
          const diff = slotTotalMins - currentTotalMins;
          if (diff > 0 && diff <= 60) return diff;
        }
        if (slotDay === tomorrowDay) {
          const diffAcrossMidnight = (1440 - currentTotalMins) + slotTotalMins;
          if (diffAcrossMidnight > 0 && diffAcrossMidnight <= 60) return diffAcrossMidnight;
        }
        return null;
      };

      // Find slots today (or rolling over past midnight into tomorrow) within 60 minutes
      let matchedSlot: { day: string; time: string } | undefined;
      let minutesRemaining = 0;
      for (const slot of connection.postingSlots) {
        const diff = computeMinutesUntilSlot(slot);
        if (diff !== null) {
          matchedSlot = slot;
          minutesRemaining = diff;
          break;
        }
      }

      if (matchedSlot) {
        // Check if there is an unassigned pending post waiting in queue
        const pendingQueuePosts = await db
          .select()
          .from(queueTable)
          .where(sql`
            connection_id = ${currentPost.connectionId}
            AND id != ${postId}
            AND status = 'pending'
            AND scheduled_at IS NULL
          `)
          .orderBy(asc(queueTable.sortOrder))
          .limit(1);

        if (pendingQueuePosts && pendingQueuePosts.length > 0) {
          const nextPost = pendingQueuePosts[0];
          return {
            hasUpcoming: true,
            type: 'auto_slot',
            minutesRemaining,
            timeStr: matchedSlot.time,
            upcomingSlotDay: matchedSlot.day,
            upcomingPostId: nextPost.id,
            upcomingPostTitle: nextPost.text?.split('\n')[0]?.replace(/[*#_`]/g, '')?.slice(0, 100) || null,
          };
        }
      }
    }

    return { hasUpcoming: false };
  } catch (err: any) {
    console.error(`[ScheduleChecker] Error checking schedule for post ${postId}:`, err.message || err);
    return { hasUpcoming: false };
  }
}
