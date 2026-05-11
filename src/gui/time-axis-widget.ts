import {
	BitmapCoordinatesRenderingScope,
	CanvasElementBitmapSizeBinding,
	CanvasRenderingTarget2D,
	equalSizes,
	MediaCoordinatesRenderingScope,
	Size,
	size,
	tryCreateCanvasRenderingTarget2D,
} from 'fancy-canvas';

import { clearRect } from '../helpers/canvas-helpers';
import { Delegate } from '../helpers/delegate';
import { IDestroyable } from '../helpers/idestroyable';
import { ISubscription } from '../helpers/isubscription';
import { makeFont } from '../helpers/make-font';

import { IDataSource } from '../model/idata-source';
import { IHorzScaleBehavior } from '../model/ihorz-scale-behavior';
import { InvalidationLevel } from '../model/invalidate-mask';
import { PrimitivePaneViewZOrder } from '../model/ipane-primitive';
import { LayoutOptions } from '../model/layout-options';
import { Pane } from '../model/pane';
import { TextWidthCache } from '../model/text-width-cache';
import { IPaneRenderer } from '../renderers/ipane-renderer';
import { TimeAxisViewRendererOptions } from '../renderers/itime-axis-view-renderer';
import { IAxisView } from '../views/pane/iaxis-view';

import { createBoundCanvas, releaseCanvas } from './canvas-utils';
import { ChartWidget } from './chart-widget';
import { drawBackground, drawForeground, drawSourceViews } from './draw-functions';
import { ITimeAxisViewsGetter } from './iaxis-view-getters';
import { MouseEventHandler, MouseEventHandlers, MouseEventHandlerTouchEvent, TouchMouseEvent } from './mouse-event-handler';
import { PriceAxisStub, PriceAxisStubParams } from './price-axis-stub';

const enum Constants {
	BorderSize = 1,
	TickLength = 5,
}

const enum CursorType {
	Default,
	EwResize,
}

function buildTimeAxisViewsGetter(zOrder: PrimitivePaneViewZOrder): ITimeAxisViewsGetter {
	return (source: IDataSource): readonly IAxisView[] => source.timePaneViews?.(zOrder) ?? [];
}
const sourcePaneViews = buildTimeAxisViewsGetter('normal');
const sourceTopPaneViews = buildTimeAxisViewsGetter('top');
const sourceBottomPaneViews = buildTimeAxisViewsGetter('bottom');

export class TimeAxisWidget<HorzScaleItem> implements MouseEventHandlers, IDestroyable {
	private readonly _chart: ChartWidget<HorzScaleItem>;
	private readonly _options: LayoutOptions;
	private readonly _element: HTMLElement;
	private readonly _leftStubCell: HTMLElement;
	private readonly _rightStubCell: HTMLElement;
	private readonly _cell: HTMLElement;
	private readonly _dv: HTMLElement;
	private readonly _canvasBinding: CanvasElementBitmapSizeBinding;
	private _leftStub: PriceAxisStub | null = null;
	private _rightStub: PriceAxisStub | null = null;
	private readonly _mouseEventHandler: MouseEventHandler;
	private _rendererOptions: TimeAxisViewRendererOptions | null = null;
	private _mouseDown: boolean = false;
	private _size: Size = size({ width: 0, height: 0 });
	private readonly _sizeChanged: Delegate<Size> = new Delegate();
	private readonly _widthCache: TextWidthCache = new TextWidthCache(5);
	private _isSettingSize: boolean = false;

	// See PriceAxisWidget._tickMarksCacheCanvas for rationale.
	private _tickMarksCacheCanvas: HTMLCanvasElement | null = null;
	private _tickMarksCacheKey: {
		bitmapW: number;
		bitmapH: number;
		marksRef: object | null;
		maxWeight: number;
		font: string;
		boldFont: string;
		allowBoldLabels: boolean;
		lineColor: string;
		textColor: string;
		borderVisible: boolean;
		ticksVisible: boolean;
	} | null = null;

	private readonly _horzScaleBehavior: IHorzScaleBehavior<HorzScaleItem>;

	public constructor(chartWidget: ChartWidget<HorzScaleItem>, horzScaleBehavior: IHorzScaleBehavior<HorzScaleItem>) {
		this._chart = chartWidget;
		this._horzScaleBehavior = horzScaleBehavior;
		this._options = chartWidget.options()['layout'];

		this._element = document.createElement('tr');

		this._leftStubCell = document.createElement('td');
		this._leftStubCell.style.padding = '0';

		this._rightStubCell = document.createElement('td');
		this._rightStubCell.style.padding = '0';

		this._cell = document.createElement('td');
		this._cell.style.height = '25px';
		this._cell.style.padding = '0';

		this._dv = document.createElement('div');
		this._dv.style.width = '100%';
		this._dv.style.height = '100%';
		this._dv.style.position = 'relative';
		this._dv.style.overflow = 'hidden';
		this._cell.appendChild(this._dv);

		this._canvasBinding = createBoundCanvas(this._dv, size({ width: 16, height: 16 }));
		this._canvasBinding.subscribeSuggestedBitmapSizeChanged(this._canvasSuggestedBitmapSizeChangedHandler);
		const canvas = this._canvasBinding.canvasElement;
		canvas.style.position = 'absolute';
		canvas.style.zIndex = '1';
		canvas.style.left = '0';
		canvas.style.top = '0';

		// Top canvas eliminated — crosshair time-label + top-z-order sources now
		// render on the main canvas. See PriceAxisWidget for the same change.

		this._element.appendChild(this._leftStubCell);
		this._element.appendChild(this._cell);
		this._element.appendChild(this._rightStubCell);

		this._recreateStubs();
		this._chart.model().priceScalesOptionsChanged().subscribe(this._recreateStubs.bind(this), this);

		this._mouseEventHandler = new MouseEventHandler(
			this._canvasBinding.canvasElement,
			this,
			{
				treatVertTouchDragAsPageScroll: () => true,
				treatHorzTouchDragAsPageScroll: () => !this._chart.options()['handleScroll'].horzTouchDrag,
			}
		);
	}

	public destroy(): void {
		this._mouseEventHandler.destroy();
		if (this._leftStub !== null) {
			this._leftStub.destroy();
		}
		if (this._rightStub !== null) {
			this._rightStub.destroy();
		}

		this._canvasBinding.unsubscribeSuggestedBitmapSizeChanged(this._canvasSuggestedBitmapSizeChangedHandler);
		releaseCanvas(this._canvasBinding.canvasElement);
		this._canvasBinding.dispose();

		if (this._tickMarksCacheCanvas !== null) {
			releaseCanvas(this._tickMarksCacheCanvas);
			this._tickMarksCacheCanvas = null;
			this._tickMarksCacheKey = null;
		}
	}

	public getElement(): HTMLElement {
		return this._element;
	}

	public leftStub(): PriceAxisStub | null {
		return this._leftStub;
	}

	public rightStub(): PriceAxisStub | null {
		return this._rightStub;
	}

	public mouseDownEvent(event: TouchMouseEvent): void {
		if (this._mouseDown) {
			return;
		}

		this._mouseDown = true;
		const model = this._chart.model();
		if (model.timeScale().isEmpty() || !this._chart.options()['handleScale'].axisPressedMouseMove.time) {
			return;
		}

		model.startScaleTime(event.localX);
	}

	public touchStartEvent(event: MouseEventHandlerTouchEvent): void {
		this.mouseDownEvent(event);
	}

	public mouseDownOutsideEvent(): void {
		const model = this._chart.model();
		if (!model.timeScale().isEmpty() && this._mouseDown) {
			this._mouseDown = false;
			if (this._chart.options()['handleScale'].axisPressedMouseMove.time) {
				model.endScaleTime();
			}
		}
	}

	public pressedMouseMoveEvent(event: TouchMouseEvent): void {
		const model = this._chart.model();
		if (model.timeScale().isEmpty() || !this._chart.options()['handleScale'].axisPressedMouseMove.time) {
			return;
		}

		model.scaleTimeTo(event.localX);
	}

	public touchMoveEvent(event: MouseEventHandlerTouchEvent): void {
		this.pressedMouseMoveEvent(event);
	}

	public mouseUpEvent(): void {
		this._mouseDown = false;
		const model = this._chart.model();
		if (model.timeScale().isEmpty() && !this._chart.options()['handleScale'].axisPressedMouseMove.time) {
			return;
		}

		model.endScaleTime();
	}

	public touchEndEvent(): void {
		this.mouseUpEvent();
	}

	public mouseDoubleClickEvent(): void {
		if (this._chart.options()['handleScale'].axisDoubleClickReset.time) {
			this._chart.model().resetTimeScale();
		}
	}

	public doubleTapEvent(): void {
		this.mouseDoubleClickEvent();
	}

	public mouseEnterEvent(): void {
		if (this._chart.model().options()['handleScale'].axisPressedMouseMove.time) {
			this._setCursor(CursorType.EwResize);
		}
	}

	public mouseLeaveEvent(): void {
		this._setCursor(CursorType.Default);
	}

	public getSize(): Size {
		return this._size;
	}

	public sizeChanged(): ISubscription<Size> {
		return this._sizeChanged;
	}

	public setSizes(timeAxisSize: Size, leftStubWidth: number, rightStubWidth: number): void {
		if (!equalSizes(this._size, timeAxisSize)) {
			this._size = timeAxisSize;

			this._isSettingSize = true;
			this._canvasBinding.resizeCanvasElement(timeAxisSize);
			this._isSettingSize = false;

			this._cell.style.width = `${timeAxisSize.width}px`;
			this._cell.style.height = `${timeAxisSize.height}px`;

			this._sizeChanged.fire(timeAxisSize);
		}

		if (this._leftStub !== null) {
			this._leftStub.setSize(size({ width: leftStubWidth, height: timeAxisSize.height }));
		}
		if (this._rightStub !== null) {
			this._rightStub.setSize(size({ width: rightStubWidth, height: timeAxisSize.height }));
		}
	}

	public optimalHeight(): number {
		const rendererOptions = this._getRendererOptions();
		return Math.ceil(
			// rendererOptions.offsetSize +
			rendererOptions.borderSize +
			rendererOptions.tickLength +
			rendererOptions.fontSize +
			rendererOptions.paddingTop +
			rendererOptions.paddingBottom +
			rendererOptions.labelBottomOffset
		);
	}

	public update(): void {
		// this call has side-effect - it regenerates marks on the time scale
		this._chart.model().timeScale().marks();
	}

	public getBitmapSize(): Size {
		return this._canvasBinding.bitmapSize;
	}

	public drawBitmap(ctx: CanvasRenderingContext2D, x: number, y: number, addTopLayer?: boolean): void {
		const bitmapSize = this.getBitmapSize();
		if (bitmapSize.width > 0 && bitmapSize.height > 0) {
			// Top layer no longer exists; main canvas already contains crosshair
			// labels and top sources. See PriceAxisWidget.drawBitmap.
			void addTopLayer;
			ctx.drawImage(this._canvasBinding.canvasElement, x, y);
		}
	}

	public paint(type: InvalidationLevel): void {
		if (type === InvalidationLevel.None) {
			return;
		}
		const canvasOptions: CanvasRenderingContext2DSettings = {
			colorSpace: this._options.colorSpace,
		};

		this._canvasBinding.applySuggestedBitmapSize();
		const target = tryCreateCanvasRenderingTarget2D(this._canvasBinding, canvasOptions);
		if (target !== null) {
			// Static + dynamic both render here now that the top canvas is gone.
			// Cached tick marks are drawImage-blitted, so Cursor-level repaints
			// stay cheap (background/border + a handful of crosshair labels).
			target.useBitmapCoordinateSpace((scope: BitmapCoordinatesRenderingScope) => {
				this._drawBackground(scope);
				this._drawBorder(scope);
				this._drawAdditionalSources(target, sourceBottomPaneViews);
			});
			this._drawCachedTickMarks(target, canvasOptions);
			this._drawAdditionalSources(target, sourcePaneViews);

			// Formerly on the top canvas:
			this._drawLabels([...this._chart.model().serieses(), this._chart.model().crosshairSource()], target);
			this._drawAdditionalSources(target, sourceTopPaneViews);
		}

		// Stubs still own their own (small) canvas; not collapsed in this release.
		if (this._leftStub !== null) {
			this._leftStub.paint(type);
		}
		if (this._rightStub !== null) {
			this._rightStub.paint(type);
		}
	}

	private _drawAdditionalSources(target: CanvasRenderingTarget2D, axisViewsGetter: ITimeAxisViewsGetter): void {
		const sources = this._chart.model().serieses();

		for (const source of sources) {
			drawSourceViews(
				axisViewsGetter,
				(renderer: IPaneRenderer) => drawBackground(renderer, target, false, undefined),
				source,
				undefined as unknown as Pane
			);
		}

		for (const source of sources) {
			drawSourceViews(
				axisViewsGetter,
				(renderer: IPaneRenderer) => drawForeground(renderer, target, false, undefined),
				source,
				undefined as unknown as Pane
			);
		}
	}

	private _drawBackground({ context: ctx, bitmapSize }: BitmapCoordinatesRenderingScope): void {
		clearRect(ctx, 0, 0, bitmapSize.width, bitmapSize.height, this._chart.model().backgroundBottomColor());
	}

	private _drawBorder({ context: ctx, bitmapSize, verticalPixelRatio }: BitmapCoordinatesRenderingScope): void {
		if (this._chart.options().timeScale.borderVisible) {
			ctx.fillStyle = this._lineColor();

			const borderSize = Math.max(1, Math.floor(this._getRendererOptions().borderSize * verticalPixelRatio));

			ctx.fillRect(0, 0, bitmapSize.width, borderSize);
		}
	}

	private _drawTickMarks(target: CanvasRenderingTarget2D): void {
		const timeScale = this._chart.model().timeScale();
		const tickMarks = timeScale.marks();

		if (!tickMarks || tickMarks.length === 0) {
			return;
		}

		const maxWeight = this._horzScaleBehavior.maxTickMarkWeight(tickMarks);

		const rendererOptions = this._getRendererOptions();

		const options = timeScale.options();
		if (options.borderVisible && options.ticksVisible) {
			target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio, verticalPixelRatio }: BitmapCoordinatesRenderingScope) => {
				ctx.strokeStyle = this._lineColor();
				ctx.fillStyle = this._lineColor();

				const tickWidth = Math.max(1, Math.floor(horizontalPixelRatio));
				const tickOffset = Math.floor(horizontalPixelRatio * 0.5);

				ctx.beginPath();
				const tickLen = Math.round(rendererOptions.tickLength * verticalPixelRatio);
				for (let index = tickMarks.length; index--;) {
					const x = Math.round(tickMarks[index].coord * horizontalPixelRatio);
					ctx.rect(x - tickOffset, 0, tickWidth, tickLen);
				}

				ctx.fill();
			});
		}

		target.useMediaCoordinateSpace(({ context: ctx }: MediaCoordinatesRenderingScope) => {
			const yText = (
				rendererOptions.borderSize +
				rendererOptions.tickLength +
				rendererOptions.paddingTop +
				rendererOptions.fontSize / 2
			);

			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillStyle = this._textColor();

			// draw base marks
			ctx.font = this._baseFont();
			for (const tickMark of tickMarks) {
				if (tickMark.weight < maxWeight) {
					const coordinate = tickMark.needAlignCoordinate ? this._alignTickMarkLabelCoordinate(ctx, tickMark.coord, tickMark.label) : tickMark.coord;
					ctx.fillText(tickMark.label, coordinate, yText);
				}
			}
			if (this._chart.options().timeScale.allowBoldLabels) {
				ctx.font = this._baseBoldFont();
			}
			for (const tickMark of tickMarks) {
				if (tickMark.weight >= maxWeight) {
					const coordinate = tickMark.needAlignCoordinate ? this._alignTickMarkLabelCoordinate(ctx, tickMark.coord, tickMark.label) : tickMark.coord;
					ctx.fillText(tickMark.label, coordinate, yText);
				}
			}
		});
	}

	/** See PriceAxisWidget._drawCachedTickMarks for rationale. */
	// eslint-disable-next-line complexity
	private _drawCachedTickMarks(target: CanvasRenderingTarget2D, canvasOptions: CanvasRenderingContext2DSettings): void {
		const timeScale = this._chart.model().timeScale();
		const tickMarks = timeScale.marks();
		if (!tickMarks || tickMarks.length === 0) {
			return;
		}

		const bitmap = this._canvasBinding.bitmapSize;
		if (bitmap.width === 0 || bitmap.height === 0) {
			return;
		}

		const options = timeScale.options();
		const tsOptions = this._chart.options().timeScale;
		const maxWeight = this._horzScaleBehavior.maxTickMarkWeight(tickMarks);
		const font = this._baseFont();
		const boldFont = this._baseBoldFont();
		const allowBoldLabels = tsOptions.allowBoldLabels;
		const lineColor = this._lineColor();
		const textColor = this._textColor();
		const borderVisible = options.borderVisible;
		const ticksVisible = options.ticksVisible;

		const key = this._tickMarksCacheKey;
		const cacheValid =
			this._tickMarksCacheCanvas !== null &&
			key !== null &&
			key.bitmapW === bitmap.width &&
			key.bitmapH === bitmap.height &&
			key.marksRef === tickMarks &&
			key.maxWeight === maxWeight &&
			key.font === font &&
			key.boldFont === boldFont &&
			key.allowBoldLabels === allowBoldLabels &&
			key.lineColor === lineColor &&
			key.textColor === textColor &&
			key.borderVisible === borderVisible &&
			key.ticksVisible === ticksVisible;

		if (!cacheValid) {
			const cacheCanvas = this._tickMarksCacheCanvas ?? document.createElement('canvas');
			if (cacheCanvas.width !== bitmap.width || cacheCanvas.height !== bitmap.height) {
				cacheCanvas.width = bitmap.width;
				cacheCanvas.height = bitmap.height;
			} else {
				const clearCtx = cacheCanvas.getContext('2d', canvasOptions);
				if (clearCtx !== null) {
					clearCtx.clearRect(0, 0, bitmap.width, bitmap.height);
				}
			}
			const cacheCtx = cacheCanvas.getContext('2d', canvasOptions);
			if (cacheCtx === null) {
				return;
			}
			const cacheTarget = new CanvasRenderingTarget2D(cacheCtx, this._size, bitmap);
			this._drawTickMarks(cacheTarget);
			this._tickMarksCacheCanvas = cacheCanvas;
			this._tickMarksCacheKey = {
				bitmapW: bitmap.width,
				bitmapH: bitmap.height,
				marksRef: tickMarks,
				maxWeight,
				font,
				boldFont,
				allowBoldLabels,
				lineColor,
				textColor,
				borderVisible,
				ticksVisible,
			};
		}

		const cached = this._tickMarksCacheCanvas as HTMLCanvasElement;
		target.useBitmapCoordinateSpace(({ context: ctx }: BitmapCoordinatesRenderingScope) => {
			ctx.drawImage(cached, 0, 0);
		});
	}

	private _alignTickMarkLabelCoordinate(ctx: CanvasRenderingContext2D, coordinate: number, labelText: string): number {
		const labelWidth = this._widthCache.measureText(ctx, labelText);
		const labelWidthHalf = labelWidth / 2;
		const leftTextCoordinate = Math.floor(coordinate - labelWidthHalf) + 0.5;

		if (leftTextCoordinate < 0) {
			coordinate = coordinate + Math.abs(0 - leftTextCoordinate);
		} else if (leftTextCoordinate + labelWidth > this._size.width) {
			coordinate = coordinate - Math.abs(this._size.width - (leftTextCoordinate + labelWidth));
		}

		return coordinate;
	}

	private _drawLabels(sources: readonly IDataSource[], target: CanvasRenderingTarget2D): void {
		const rendererOptions = this._getRendererOptions();
		for (const source of sources) {
			for (const view of source.timeAxisViews()) {
				view.renderer().draw(target, rendererOptions);
			}
		}
	}

	private _lineColor(): string {
		return this._chart.options().timeScale.borderColor;
	}

	private _textColor(): string {
		return this._options.textColor;
	}

	private _fontSize(): number {
		return this._options.fontSize;
	}

	private _baseFont(): string {
		return makeFont(this._fontSize(), this._options.fontFamily);
	}

	private _baseBoldFont(): string {
		return makeFont(this._fontSize(), this._options.fontFamily, 'bold');
	}

	private _getRendererOptions(): Readonly<TimeAxisViewRendererOptions> {
		if (this._rendererOptions === null) {
			this._rendererOptions = {
				borderSize: Constants.BorderSize,
				baselineOffset: NaN,
				paddingTop: NaN,
				paddingBottom: NaN,
				paddingHorizontal: NaN,
				tickLength: Constants.TickLength,
				fontSize: NaN,
				font: '',
				widthCache: new TextWidthCache(),
				labelBottomOffset: 0,
			};
		}

		const rendererOptions = this._rendererOptions;
		const newFont = this._baseFont();

		if (rendererOptions.font !== newFont) {
			const fontSize = this._fontSize();
			rendererOptions.fontSize = fontSize;
			rendererOptions.font = newFont;
			rendererOptions.paddingTop = 3 * fontSize / 12;
			rendererOptions.paddingBottom = 3 * fontSize / 12;
			rendererOptions.paddingHorizontal = 9 * fontSize / 12;
			rendererOptions.baselineOffset = 0;
			rendererOptions.labelBottomOffset = 4 * fontSize / 12;
			rendererOptions.widthCache.reset();
		}

		return this._rendererOptions;
	}

	private _setCursor(type: CursorType): void {
		this._cell.style.cursor = type === CursorType.EwResize ? 'ew-resize' : 'default';
	}

	private _recreateStubs(): void {
		const model = this._chart.model();
		const options = model.options();
		if (!options.leftPriceScale.visible && this._leftStub !== null) {
			this._leftStubCell.removeChild(this._leftStub.getElement());
			this._leftStub.destroy();
			this._leftStub = null;
		}
		if (!options.rightPriceScale.visible && this._rightStub !== null) {
			this._rightStubCell.removeChild(this._rightStub.getElement());
			this._rightStub.destroy();
			this._rightStub = null;
		}
		const rendererOptionsProvider = this._chart.model().rendererOptionsProvider();
		const params: PriceAxisStubParams = {
			rendererOptionsProvider: rendererOptionsProvider,
		};

		const borderVisibleGetter = () => {
			return options.leftPriceScale.borderVisible && model.timeScale().options().borderVisible;
		};

		const bottomColorGetter = () => model.backgroundBottomColor();

		if (options.leftPriceScale.visible && this._leftStub === null) {
			this._leftStub = new PriceAxisStub('left', options, params, borderVisibleGetter, bottomColorGetter);
			this._leftStubCell.appendChild(this._leftStub.getElement());
		}
		if (options.rightPriceScale.visible && this._rightStub === null) {
			this._rightStub = new PriceAxisStub('right', options, params, borderVisibleGetter, bottomColorGetter);
			this._rightStubCell.appendChild(this._rightStub.getElement());
		}
	}

	private readonly _canvasSuggestedBitmapSizeChangedHandler = () => {
		if (!this._isSettingSize) {
			this._chart.model().lightUpdate();
		}
	};
}
