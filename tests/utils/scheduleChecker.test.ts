import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkUpcomingSchedule } from '../../src/utils/scheduleChecker.js';

describe('Schedule Checker: checkUpcomingSchedule', () => {
  let mockDb: any;
  let mockGetConnection: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    };

    mockGetConnection = vi.fn().mockResolvedValue({
      id: 1,
      name: 'poros.perjuangan',
      postingSlots: [
        { day: 'Wednesday', time: '14:30' },
        { day: 'Wednesday', time: '18:00' }
      ]
    });
  });

  it('should return hasUpcoming: false when there are no scheduled posts or slots in the next 60 minutes', async () => {
    // Current time is Wednesday 10:00 (no slot in next 60 mins)
    const refTime = new Date('2026-09-16T03:00:00.000Z'); // 10:00 WIB

    // 1st call: fetch target post
    mockDb.limit.mockResolvedValueOnce([{ id: 10, connectionId: 1, status: 'pending' }]);
    // 2nd call: fetch upcoming custom scheduled posts -> none
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await checkUpcomingSchedule({
      db: mockDb,
      postId: 10,
      getConnectionFn: mockGetConnection,
      referenceTime: refTime,
    });

    expect(result.hasUpcoming).toBe(false);
  });

  it('should detect upcoming custom scheduled post in the next 60 minutes', async () => {
    // Current time is Wednesday 14:00 (scheduled post is at 14:25, so in 25 mins)
    const refTime = new Date('2026-09-16T07:00:00.000Z'); // 14:00 WIB
    const scheduledAt = new Date('2026-09-16T07:25:00.000Z'); // 14:25 WIB

    // 1st call: target post
    mockDb.limit.mockResolvedValueOnce([{ id: 10, connectionId: 1, status: 'pending' }]);
    // 2nd call: upcoming custom scheduled post
    mockDb.limit.mockResolvedValueOnce([
      {
        id: 12,
        connectionId: 1,
        status: 'pending',
        scheduledAt: scheduledAt,
        text: 'Upcoming breaking news on economy',
      }
    ]);

    const result = await checkUpcomingSchedule({
      db: mockDb,
      postId: 10,
      getConnectionFn: mockGetConnection,
      referenceTime: refTime,
    });

    expect(result.hasUpcoming).toBe(true);
    expect(result.type).toBe('scheduled_post');
    expect(result.minutesRemaining).toBe(25);
    expect(result.upcomingPostId).toBe(12);
    expect(result.upcomingPostTitle).toBe('Upcoming breaking news on economy');
  });

  it('should detect auto-slot in the next 60 minutes when pending queue posts exist', async () => {
    // Current time is Wednesday 14:10 (slot is at 14:30, so in 20 mins)
    const refTime = new Date('2026-09-16T07:10:00.000Z'); // 14:10 WIB

    // 1st call: target post
    mockDb.limit.mockResolvedValueOnce([{ id: 10, connectionId: 1, status: 'pending' }]);
    // 2nd call: upcoming custom scheduled posts -> none
    mockDb.limit.mockResolvedValueOnce([]);
    // 3rd call: check if there is a pending queue post waiting for the auto-slot
    mockDb.limit.mockResolvedValueOnce([
      { id: 15, connectionId: 1, status: 'pending', text: 'Auto slot pending post' }
    ]);

    const result = await checkUpcomingSchedule({
      db: mockDb,
      postId: 10,
      getConnectionFn: mockGetConnection,
      referenceTime: refTime,
    });

    expect(result.hasUpcoming).toBe(true);
    expect(result.type).toBe('auto_slot');
    expect(result.minutesRemaining).toBe(20);
    expect(result.timeStr).toBe('14:30');
    expect(result.upcomingPostId).toBe(15);
    expect(result.upcomingPostTitle).toBe('Auto slot pending post');
  });

  it('should detect auto-slot across midnight rollover (e.g. 23:30 WIB to 00:15 WIB next day)', async () => {
    // Wednesday 23:30 WIB = 2026-09-16T16:30:00.000Z
    const refTime = new Date('2026-09-16T16:30:00.000Z');
    mockGetConnection.mockResolvedValueOnce({
      id: 1,
      postingSlots: [{ day: 'Thursday', time: '00:15' }],
    });

    mockDb.limit.mockResolvedValueOnce([{ id: 10, connectionId: 1, status: 'pending' }]);
    mockDb.limit.mockResolvedValueOnce([]);
    mockDb.limit.mockResolvedValueOnce([
      { id: 19, connectionId: 1, status: 'pending', text: 'Midnight rollover post' }
    ]);

    const result = await checkUpcomingSchedule({
      db: mockDb,
      postId: 10,
      getConnectionFn: mockGetConnection,
      referenceTime: refTime,
    });

    expect(result.hasUpcoming).toBe(true);
    expect(result.type).toBe('auto_slot');
    expect(result.minutesRemaining).toBe(45);
    expect(result.timeStr).toBe('00:15');
    expect(result.upcomingSlotDay).toBe('Thursday');
    expect(result.upcomingPostId).toBe(19);
  });
});
