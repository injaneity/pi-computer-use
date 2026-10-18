import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CdpPageSnapshot } from "./cdp.ts";
import type { ImageMode } from "./contract.ts";
import type { JevPageSnapshot } from "./jev/types.ts";
import type { WindowNote } from "./note.ts";
import { restoreOutline, serializeOutline, type LookResponse, type Outline, type SerializedOutline } from "./outline.ts";
import { StateStore, type StoredState } from "./runtime.ts";

interface StateTargetSnapshot {
	pid: number;
	windowId: number;
	windowRef?: string;
}

export interface CurrentTarget {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId: number;
	windowRef?: string;
	nativeWindowRef?: string;
}

export interface CurrentCapture {
	stateId: string;
	width: number;
	height: number;
	scaleFactor: number;
	timestamp: number;
}

export interface OperationState {
	currentTarget?: CurrentTarget;
	currentCapture?: CurrentCapture;
	currentStateTarget?: StateTargetSnapshot;
	currentImageMode?: ImageMode;
	currentLook?: LookResponse;
	currentOutline?: Outline;
	currentNote?: WindowNote;
	resourceKey?: string;
	epoch?: number;
	lastSearchOcrEscalatedLookId?: string;
	browserSnapshot?: CdpPageSnapshot;
	contextId?: string;
	jevSnapshot?: JevPageSnapshot;
	jevRootRef?: string;
}

interface DesktopObservation {
	kind: "desktop";
	target: CurrentTarget;
	capture: CurrentCapture;
	look: Omit<LookResponse, "parsedOutline" | "outline">;
	outline: SerializedOutline;
	note?: WindowNote;
	imageMode?: ImageMode;
}

interface BrowserObservation {
	kind: "browser";
	snapshot: CdpPageSnapshot;
	outline: SerializedOutline;
}

interface JevObservation {
	kind: "jev";
	snapshot: JevPageSnapshot;
	rootRef?: string;
}

export type UiObservation = DesktopObservation | BrowserObservation | JevObservation;

export class SavedStates {
	readonly store = new StateStore<UiObservation>(128);
	readonly operations = new AsyncLocalStorage<OperationState>();

	current(): OperationState {
		const state = this.operations.getStore();
		if (!state) throw new Error("Computer-use operation state is unavailable.");
		return state;
	}

	get(stateId: string): StoredState<UiObservation> | undefined {
		return this.store.get(stateId);
	}

	set(record: StoredState<UiObservation>): void {
		this.store.set(record);
	}

	/** Store one immutable jev observation and return its agent-facing state id. */
	saveJev(snapshot: JevPageSnapshot, resourceKey: string, epoch: number, rootRef?: string): StoredState<UiObservation> {
		const record: StoredState<UiObservation> = {
			stateId: randomUUID(),
			resourceKey,
			epoch,
			value: { kind: "jev", snapshot, rootRef },
		};
		this.store.set(record);
		return record;
	}

	clear(): void {
		this.store.clear();
	}

	hydrate(record: StoredState<UiObservation> | undefined): OperationState {
		if (!record) return {};
		if (record.value.kind === "jev") {
			const { snapshot } = record.value;
			return {
				currentCapture: { stateId: record.stateId, width: 0, height: 0, scaleFactor: 1, timestamp: snapshot.capturedAt },
				resourceKey: record.resourceKey,
				epoch: record.epoch,
				contextId: snapshot.contextId,
				jevSnapshot: snapshot,
				jevRootRef: record.value.rootRef,
			};
		}
		if (record.value.kind === "browser") {
			const outline = restoreOutline(record.value.outline);
			return {
				currentCapture: { stateId: record.stateId, width: 0, height: 0, scaleFactor: 1, timestamp: record.value.snapshot.capturedAt },
				currentLook: {
					lookId: record.value.snapshot.snapshotId,
					capturedAt: record.value.snapshot.capturedAt / 1000,
					window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
					outline: outline.root,
					timings: {},
					parsedOutline: outline,
				},
				currentOutline: outline,
				resourceKey: record.resourceKey,
				epoch: record.epoch,
				browserSnapshot: record.value.snapshot,
				contextId: record.value.snapshot.contextId,
			};
		}
		const outline = restoreOutline(record.value.outline);
		return {
			currentTarget: { ...record.value.target },
			currentCapture: { ...record.value.capture },
			currentStateTarget: { pid: record.value.target.pid, windowId: record.value.target.windowId, windowRef: record.value.target.windowRef },
			currentImageMode: record.value.imageMode,
			currentLook: { ...record.value.look, outline: outline.root, parsedOutline: outline },
			currentOutline: outline,
			currentNote: record.value.note ? structuredClone(record.value.note) : undefined,
			resourceKey: record.resourceKey,
			epoch: record.epoch,
		};
	}

	saveDesktop(state: OperationState, resourceKey: string, epoch: number): void {
		if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline) return;
		this.store.set({
			stateId: state.currentCapture.stateId,
			resourceKey,
			epoch,
			value: {
				kind: "desktop",
				target: { ...state.currentTarget },
				capture: { ...state.currentCapture },
				look: {
					lookId: state.currentLook.lookId,
					capturedAt: state.currentLook.capturedAt,
					window: structuredClone(state.currentLook.window),
					image: state.currentLook.image ? { ...state.currentLook.image } : undefined,
					timings: { ...state.currentLook.timings },
					readText: state.currentLook.readText ? { ...state.currentLook.readText } : undefined,
				},
				outline: serializeOutline(state.currentOutline),
				note: state.currentNote ? structuredClone(state.currentNote) : undefined,
				imageMode: state.currentImageMode,
			},
		});
	}
}
