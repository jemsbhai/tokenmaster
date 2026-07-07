"""The context gauge: hero surface of ctxmaster (contract decision D10).

Renders a tokenmaster MeterState as a terminal panel: a zone-colored fill
bar against the effective window with threshold ticks, and ancillary rows
for context accounting, velocity, ETA, zone, and the optional extras
(reserved output, hidden overhead, cache prefix). Every number displayed
comes straight from MeterState; the gauge computes nothing itself.

Note on threshold ticks: MeterState (schema 0.1) does not carry the zone
thresholds, so the gauge takes them as display parameters defaulting to the
contract values (caution 0.70, critical 0.85). A Meter configured with
custom thresholds should be paired with a gauge constructed to match.
Promoting thresholds into MeterState is a schema 0.2 candidate.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Callable, Iterator

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from tokenmaster import Meter, TurnRecorded
from tokenmaster.types import MeterState, Zone

ZONE_STYLE = {
    Zone.GREEN: "green",
    Zone.CAUTION: "yellow3",
    Zone.CRITICAL: "red3",
}

_FILLED = "\u2588"   # full block
_EMPTY = "\u2591"    # light shade
_TICK = "\u2502"     # vertical line


class ContextGauge:
    """Terminal renderer for MeterState."""

    def __init__(
        self,
        console: Console | None = None,
        *,
        bar_width: int = 50,
        caution: float = 0.70,
        critical: float = 0.85,
    ) -> None:
        if bar_width < 5:
            raise ValueError("bar_width must be at least 5")
        self.console = console or Console()
        self.bar_width = bar_width
        self.caution = caution
        self.critical = critical

    # ------------------------------------------------------------------ #
    # rendering (pure)

    def render(self, state: MeterState) -> Panel:
        zone_style = ZONE_STYLE[state.zone]
        body = Group(self._bar_line(state), self._info_grid(state))
        return Panel(
            body,
            title=f"ctxmaster \u00b7 {state.model_id}",
            subtitle=f"turn {state.turns}",
            border_style=zone_style,
            padding=(0, 1),
        )

    def _bar_line(self, state: MeterState) -> Text:
        width = self.bar_width
        fill = min(max(state.fill_effective, 0.0), 1.0)
        filled = round(fill * width)
        ticks = {
            min(width - 1, round(self.caution * width)),
            min(width - 1, round(self.critical * width)),
        }
        bar = Text()
        for i in range(width):
            if i < filled:
                bar.append(_FILLED, style=ZONE_STYLE[state.zone])
            elif i in ticks:
                bar.append(_TICK, style="dim")
            else:
                bar.append(_EMPTY, style="grey37")
        bar.append(f" {state.fill_effective:6.1%}", style="bold")
        return bar

    def _info_grid(self, state: MeterState) -> Table:
        grid = Table.grid(padding=(0, 2))
        grid.add_column(style="dim", no_wrap=True)
        grid.add_column()

        used = f"{state.used_tokens:,} / {state.window_effective:,} effective"
        nominal = f"({state.window_nominal:,} nominal)"
        grid.add_row("context", f"{used} {nominal}")
        grid.add_row("capacity", state.effective_source)

        if state.velocity is not None and state.velocity_std is not None:
            grid.add_row(
                "velocity",
                f"{state.velocity:,.0f} \u00b1 {state.velocity_std:,.0f} tok/turn",
            )
        else:
            grid.add_row("velocity", state.provenance.get("velocity", "unavailable"))

        if state.eta_turns is not None:
            grid.add_row(
                "eta",
                f"{state.eta_turns.expected:,.1f} turns "
                f"({state.eta_turns.conservative:,.1f} conservative)",
            )
        else:
            grid.add_row("eta", state.provenance.get("eta_turns", "unavailable"))

        grid.add_row(
            "zone", Text(state.zone.value.upper(), style=f"bold {ZONE_STYLE[state.zone]}")
        )

        if state.reserved_output:
            grid.add_row("reserved", f"{state.reserved_output:,} tok output")
        if state.hidden_overhead is not None:
            grid.add_row(
                "overhead",
                f"{state.hidden_overhead:,} tok (system prompt + tool schemas)",
            )
        if state.cache is not None:
            grid.add_row(
                "cache", f"~{state.cache.stable_prefix_tokens:,} tok stable prefix"
            )
        return grid

    # ------------------------------------------------------------------ #
    # output

    def print(self, state: MeterState) -> None:
        self.console.print(self.render(state))

    def attach(self, meter: Meter) -> Callable[[], None]:
        """Print a fresh gauge on every recorded turn; returns unsubscriber."""

        def on_event(event: Any) -> None:
            if isinstance(event, TurnRecorded):
                self.print(event.state)

        return meter.subscribe(on_event)

    @contextmanager
    def live(self, meter: Meter) -> Iterator[Live]:
        """In-place updating gauge bound to a meter, for interactive use."""
        with Live(
            self.render(meter.state()), console=self.console, refresh_per_second=8
        ) as live:

            def on_event(event: Any) -> None:
                if isinstance(event, TurnRecorded):
                    live.update(self.render(event.state))

            unsubscribe = meter.subscribe(on_event)
            try:
                yield live
            finally:
                unsubscribe()


__all__ = ["ContextGauge", "ZONE_STYLE"]
