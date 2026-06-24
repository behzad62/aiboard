"use client";

import { useMemo, useState } from "react";
import { Check, RotateCcw, Ship, Shuffle } from "lucide-react";
import {
  BATTLESHIP_BOARD_SIZE,
  BATTLESHIP_FLEET,
  canPlaceBattleshipShip,
  createBattleshipShip,
  getBattleshipPlacementPreview,
  targetToLabel,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipOrientation,
  BattleshipPlayer,
  BattleshipShip,
} from "@/lib/games/battleship/types";
import { cn } from "@/lib/utils";
import { playerLabel } from "./view-helpers";

interface BattleshipPlacementPanelProps {
  player: BattleshipPlayer;
  ships: BattleshipShip[];
  selectedShipId: string;
  orientation: BattleshipOrientation;
  error: string | null;
  onSelectShip: (shipId: string) => void;
  onOrientationChange: (orientation: BattleshipOrientation) => void;
  onPlaceShip: (ship: BattleshipShip) => void;
  onRemoveShip: (shipId: string) => void;
  onAutoPlace: () => void;
  onClear: () => void;
  onConfirm: () => void;
}

export function BattleshipPlacementPanel({
  player,
  ships,
  selectedShipId,
  orientation,
  error,
  onSelectShip,
  onOrientationChange,
  onPlaceShip,
  onRemoveShip,
  onAutoPlace,
  onClear,
  onConfirm,
}: BattleshipPlacementPanelProps) {
  const selectedDefinition =
    BATTLESHIP_FLEET.find((ship) => ship.id === selectedShipId) ??
    BATTLESHIP_FLEET[0];
  const canConfirm = ships.length === BATTLESHIP_FLEET.length;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-xl dark:border-slate-800 dark:bg-slate-950/90">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-300">
            Fleet placement
          </p>
          <h1 className="mt-2 text-3xl font-bold">
            {playerLabel(player)} setup
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Place each ship without overlap. Click a placed ship to remove it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onOrientationChange("horizontal")}
            className={orientationButtonClass(orientation === "horizontal")}
          >
            Horizontal
          </button>
          <button
            type="button"
            onClick={() => onOrientationChange("vertical")}
            className={orientationButtonClass(orientation === "vertical")}
          >
            Vertical
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <PlacementBoard
          player={player}
          ships={ships}
          selectedDefinition={selectedDefinition}
          orientation={orientation}
          onPlaceShip={onPlaceShip}
          onRemoveShip={onRemoveShip}
        />

        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 text-sm font-semibold">Ships</div>
            <div className="space-y-2">
              {BATTLESHIP_FLEET.map((definition) => {
                const placed = ships.some((ship) => ship.id === definition.id);
                return (
                  <button
                    key={definition.id}
                    type="button"
                    onClick={() => onSelectShip(definition.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition",
                      selectedShipId === definition.id
                        ? "border-sky-500 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-950/50 dark:text-sky-200"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Ship className="h-4 w-4" aria-hidden="true" />
                      <span>{definition.name}</span>
                    </span>
                    <span className="text-xs font-semibold">
                      {placed ? "Placed" : definition.size}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="grid gap-2">
            <button
              type="button"
              onClick={onAutoPlace}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm font-semibold text-sky-800 transition hover:bg-sky-100 active:scale-95 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
            >
              <Shuffle className="h-4 w-4" aria-hidden="true" />
              Auto place
            </button>
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Clear
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canConfirm}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="battleship-confirm-placement"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Confirm fleet
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function PlacementBoard({
  player,
  ships,
  selectedDefinition,
  orientation,
  onPlaceShip,
  onRemoveShip,
}: {
  player: BattleshipPlayer;
  ships: BattleshipShip[];
  selectedDefinition: (typeof BATTLESHIP_FLEET)[number];
  orientation: BattleshipOrientation;
  onPlaceShip: (ship: BattleshipShip) => void;
  onRemoveShip: (shipId: string) => void;
}) {
  const [previewStart, setPreviewStart] =
    useState<BattleshipCoordinate | null>(null);
  const existingShips = useMemo(
    () => ships.filter((ship) => ship.id !== selectedDefinition.id),
    [selectedDefinition.id, ships]
  );
  const preview = previewStart
    ? getBattleshipPlacementPreview(
        existingShips,
        selectedDefinition,
        previewStart,
        orientation
      )
    : null;
  const previewCellKeys = useMemo(
    () =>
      new Set(
        preview?.cells
          .filter(
            (cell) =>
              cell.row >= 0 &&
              cell.row < BATTLESHIP_BOARD_SIZE &&
              cell.column >= 0 &&
              cell.column < BATTLESHIP_BOARD_SIZE
          )
          .map(cellKey) ?? []
      ),
    [preview]
  );

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900"
      onMouseLeave={() => setPreviewStart(null)}
    >
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-1">
        <div />
        <div
          className="grid gap-1 text-center text-[11px] font-semibold text-slate-500"
          style={{
            gridTemplateColumns: `repeat(${BATTLESHIP_BOARD_SIZE}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: BATTLESHIP_BOARD_SIZE }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>

        {Array.from({ length: BATTLESHIP_BOARD_SIZE }, (_, row) => (
          <PlacementRow
            key={row}
            row={row}
            player={player}
            ships={ships}
            existingShips={existingShips}
            selectedDefinition={selectedDefinition}
            orientation={orientation}
            previewCellKeys={previewCellKeys}
            previewIsValid={preview?.isValid ?? false}
            onPlaceShip={onPlaceShip}
            onRemoveShip={onRemoveShip}
            onPreviewStart={setPreviewStart}
          />
        ))}
      </div>
    </div>
  );
}

function PlacementRow({
  row,
  player,
  ships,
  existingShips,
  selectedDefinition,
  orientation,
  previewCellKeys,
  previewIsValid,
  onPlaceShip,
  onRemoveShip,
  onPreviewStart,
}: {
  row: number;
  player: BattleshipPlayer;
  ships: BattleshipShip[];
  existingShips: BattleshipShip[];
  selectedDefinition: (typeof BATTLESHIP_FLEET)[number];
  orientation: BattleshipOrientation;
  previewCellKeys: Set<string>;
  previewIsValid: boolean;
  onPlaceShip: (ship: BattleshipShip) => void;
  onRemoveShip: (shipId: string) => void;
  onPreviewStart: (target: BattleshipCoordinate) => void;
}) {
  const rowLabel = String.fromCharCode(65 + row);

  return (
    <>
      <div className="flex items-center justify-center text-xs font-semibold text-slate-500">
        {rowLabel}
      </div>
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${BATTLESHIP_BOARD_SIZE}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: BATTLESHIP_BOARD_SIZE }, (_, column) => {
          const target = { row, column };
          const targetKey = cellKey(target);
          const occupyingShip = ships.find((ship) =>
            ship.cells.some(
              (cell) => cell.row === row && cell.column === column
            )
          );
          const canPlace = canPlaceBattleshipShip(
            existingShips,
            selectedDefinition,
            target,
            orientation
          );
          const inPreview = previewCellKeys.has(targetKey);

          return (
            <button
              key={`${row}:${column}`}
              type="button"
              onMouseEnter={() => onPreviewStart(target)}
              onMouseMove={() => onPreviewStart(target)}
              onPointerEnter={() => onPreviewStart(target)}
              onPointerMove={() => onPreviewStart(target)}
              onFocus={() => onPreviewStart(target)}
              onClick={() => {
                if (occupyingShip) {
                  onRemoveShip(occupyingShip.id);
                  return;
                }
                if (!canPlace) return;
                onPlaceShip(
                  createBattleshipShip(selectedDefinition, target, orientation)
                );
              }}
              className={cn(
                "aspect-square min-h-8 rounded-md border text-[10px] font-bold transition",
                "border-sky-900/20 bg-sky-100 shadow-inner dark:border-sky-400/20 dark:bg-sky-950",
                occupyingShip &&
                  (player === "blue"
                    ? "bg-sky-500 text-white dark:bg-sky-500"
                    : "bg-orange-500 text-white dark:bg-orange-500"),
                !occupyingShip &&
                  inPreview &&
                  previewIsValid &&
                  "bg-emerald-200 ring-2 ring-emerald-500 dark:bg-emerald-900/70",
                !occupyingShip &&
                  inPreview &&
                  !previewIsValid &&
                  "bg-red-100 ring-2 ring-red-400 dark:bg-red-950/70",
                !occupyingShip &&
                  canPlace &&
                  "hover:-translate-y-0.5 hover:bg-emerald-100 hover:ring-2 hover:ring-emerald-400 dark:hover:bg-emerald-950"
              )}
              data-testid={`battleship-placement-cell-${targetToLabel(target)}`}
              aria-label={targetToLabel(target)}
            >
              {occupyingShip
                ? occupyingShip.name.charAt(0)
                : inPreview
                  ? selectedDefinition.name.charAt(0)
                  : ""}
            </button>
          );
        })}
      </div>
    </>
  );
}

function cellKey(target: BattleshipCoordinate): string {
  return `${target.row}:${target.column}`;
}

function orientationButtonClass(active: boolean): string {
  return cn(
    "rounded-lg border px-4 py-2 text-sm font-semibold transition active:scale-95",
    active
      ? "border-sky-500 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-950/50 dark:text-sky-200"
      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
  );
}
