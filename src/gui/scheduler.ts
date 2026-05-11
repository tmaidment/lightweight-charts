/**
Module-level shared rAF scheduler.

Replaces the per-ChartWidget requestAnimationFrame loop. All registered
widgets paint inside one shared rAF callback, in two phases:

Phase A — measure: every widget runs any DOM-reading / layout-affecting
work (e.g. _adjustSizeImpl writing cell width/height, optimalWidth canvas
measurements, autoScale, time scale invalidations). Results are cached on
the widget.

Phase B — draw: every widget paints canvases only. No DOM reads, no DOM
writes. The browser does at most one layout flush per frame, between Phase
A and Phase B.

With N charts on a page this reduces N rAF callbacks to 1 and avoids the
N forced layout recalculations that would otherwise happen if reads and
writes were interleaved.
 */

export interface ISchedulableWidget {
	measureBeforeDraw(time: number): void;
	drawAfterMeasure(): void;
}

const pending: Set<ISchedulableWidget> = new Set();
let rafId = 0;
let batchDepth = 0;
let minFrameIntervalMs = 0;
let lastFlushTime = 0;

/**
 * Cap the shared scheduler's paint rate. Pass an FPS value (e.g. 30 or 15) to
 * throttle, or 0 (default) for native rAF rate. Useful for many-chart pages
 * where the visual quality at 60fps isn't worth the CPU/GPU cost.
 *
 * When throttled, invalidations still accumulate without delay — only the
 * paint flush is gated. The next paint catches up with the merged mask.
 */
export function setSchedulerMaxFps(fps: number): void {
	minFrameIntervalMs = fps > 0 ? 1000 / fps : 0;
}

export function getSchedulerMaxFps(): number {
	return minFrameIntervalMs > 0 ? 1000 / minFrameIntervalMs : 0;
}

function flushFrame(time: number): void {
	if (minFrameIntervalMs > 0 && time - lastFlushTime < minFrameIntervalMs) {
		// Too soon — reschedule this same flush for the next rAF tick.
		// Invalidations stay queued; we just wait one more frame.
		rafId = window.requestAnimationFrame(flushFrame);
		return;
	}
	lastFlushTime = time;
	rafId = 0;
	const work = Array.from(pending);
	pending.clear();

	// Phase A: every widget measures + writes its own DOM/layout state.
	for (const widget of work) {
		widget.measureBeforeDraw(time);
	}

	// Browser implicitly flushes layout once here, before Phase B reads anything.
	// Phase B: every widget paints canvases. No DOM access.
	for (const widget of work) {
		widget.drawAfterMeasure();
	}
}

export function schedule(widget: ISchedulableWidget): void {
	pending.add(widget);
	if (batchDepth > 0) {
		return;
	}
	if (rafId === 0) {
		rafId = window.requestAnimationFrame(flushFrame);
	}
}

export function unschedule(widget: ISchedulableWidget): void {
	pending.delete(widget);
	if (pending.size === 0 && rafId !== 0) {
		window.cancelAnimationFrame(rafId);
		rafId = 0;
	}
}

export function isPending(widget: ISchedulableWidget): boolean {
	return pending.has(widget);
}

/**
 * Run fn() with paint scheduling suspended. Useful when applying many
 * synchronous updates across multiple charts that span an await boundary or
 * other rAF tick; all invalidations accumulate and paint in one frame after
 * the outer batch returns.
 */
export function batch<T>(fn: () => T): T {
	batchDepth++;
	try {
		return fn();
	} finally {
		batchDepth--;
		if (batchDepth === 0 && pending.size > 0 && rafId === 0) {
			rafId = window.requestAnimationFrame(flushFrame);
		}
	}
}
