/**
 * Host half of the calendar bundle.
 *
 * The drawing — lunar almanac, month grid, itinerary, daily reading — all runs
 * in the Client module. The Host half exists for one reason the browser cannot
 * do itself: Google's iCal feed sends no CORS headers, so somebody on this
 * machine has to fetch it. That is the loopback service below. It is read-only
 * apart from storing the feed URL in the secrets directory.
 */
import { startCalendarSync } from './host/server.js';

const PORT = 47831;

export function apply(ctx) {
  ctx.effect(() => {
    const handle = startCalendarSync({
      port: PORT,
      log: (msg) => {
        try {
          if (ctx.logger) ctx.logger.info(msg);
          else console.log(msg);
        } catch (err) {
          console.log(msg);
        }
      },
    });
    return () => handle.close();
  }, 'calendar: phone-calendar sync service');
}
