"""Everything the board card and the rule engine derive from a project's tasks.

Pure: no database, no FastAPI. `_Task` duck-types the four cost/done pairs the
real AitoTask row exposes, which is the whole reason `summarise` takes an
iterable of anything.
"""

from dataclasses import dataclass

from backend.app.services.aito_board_rules import TaskSummary, summarise


@dataclass
class _Task:
    scan_cost: float | None = None
    modelisation_cost: float | None = None
    impression_cost: float | None = None
    usinage_cost: float | None = None
    scan_done: bool = False
    modelisation_done: bool = False
    impression_done: bool = False
    usinage_done: bool = False


def test_no_tasks_is_all_empty():
    assert summarise([]) == TaskSummary()


def test_all_null_costs_yield_no_services_and_no_total():
    summary = summarise([_Task()])
    assert summary.count == 1
    assert summary.total == 0.0
    assert summary.services == ()
    assert summary.pending == ()


def test_a_zero_cost_is_an_enabled_service():
    """0 means quoted free and is a real step; None means absent."""
    summary = summarise([_Task(modelisation_cost=0.0)])
    assert summary.services == ("modelisation",)
    assert summary.pending == ("modelisation",)
    assert summary.total == 0.0


def test_total_sums_every_enabled_cost_across_tasks():
    summary = summarise([_Task(scan_cost=5000, impression_cost=2400), _Task(usinage_cost=1000)])
    assert summary.count == 2
    assert summary.total == 8400


def test_services_are_in_canonical_order_regardless_of_task_order():
    summary = summarise([_Task(usinage_cost=1), _Task(scan_cost=1), _Task(impression_cost=1)])
    assert summary.services == ("scan", "impression", "usinage")


def test_a_ticked_step_leaves_services_but_drops_out_of_pending():
    summary = summarise([_Task(scan_cost=1, scan_done=True)])
    assert summary.services == ("scan",)
    assert summary.pending == ()


def test_a_service_enabled_on_two_tasks_is_pending_if_either_is_unticked():
    summary = summarise([_Task(scan_cost=1, scan_done=True), _Task(scan_cost=1, scan_done=False)])
    assert summary.services == ("scan",)
    assert summary.pending == ("scan",)


def test_a_done_flag_on_an_absent_service_is_ignored():
    assert summarise([_Task(scan_cost=None, scan_done=True)]).pending == ()
