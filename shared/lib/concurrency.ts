/**
 * concurrency.ts - shared/lib/concurrency.ts
 *
 * Run async work over a list with a cap on how much happens at once.
 *
 * The pattern this replaces is a plain sequential loop:
 *
 *     for (const doc of docs) results.push(await fetch(doc));
 *
 * which is correct but pays the full round-trip latency once per item. With ten
 * registered accounts and a one-second portal response, that is ten seconds of
 * a command sitting there doing nothing.
 *
 * `Promise.all` over the whole list is the other extreme: it opens every
 * connection at once, which on a phone means exhausting sockets and getting
 * rate-limited by the far end. A small fixed pool gets nearly all the speedup
 * without either problem.
 */

/**
 * Map over `items` with at most `limit` promises in flight.
 *
 * Results come back in input order regardless of completion order. A rejection
 * propagates, so wrap the worker if partial failure should be tolerated - see
 * `mapLimitSettled`.
 */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];

    const width = Math.max(1, Math.min(limit, items.length));
    const results = new Array<R>(items.length);

    // Shared cursor: each runner takes the next index rather than a fixed slice,
    // so one slow item doesn't leave its lane idle while others queue behind it.
    let cursor = 0;

    const runner = async (): Promise<void> => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await worker(items[index]!, index);
        }
    };

    await Promise.all(Array.from({ length: width }, runner));
    return results;
}

/**
 * Like mapLimit, but a failing item yields null instead of aborting the batch.
 *
 * This is what most callers here want: one unreachable account should not cost
 * the whole comparison.
 */
export async function mapLimitSettled<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<(R | null)[]> {
    return mapLimit(items, limit, async (item, index) => {
        try {
            return await worker(item, index);
        } catch (err) {
            console.error("[concurrency] item failed:", err instanceof Error ? err.message : err);
            return null;
        }
    });
}
