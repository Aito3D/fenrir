"""Everything the board card and the rule engine derive from a project's tasks.

Pure: no database, no FastAPI. `_Task` duck-types the four cost/done pairs the
real AitoTask row exposes, which is the whole reason `summarise` takes an
iterable of anything.
"""

from dataclasses import dataclass
from datetime import datetime

from backend.app.services.aito_board_rules import TaskSteps, TaskSummary, summarise


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


def test_step_counters_count_priced_services_only():
    # scan and impression are priced (0 counts — free is real work);
    # modelisation and usinage are absent from the job.
    summary = summarise([_Task(scan_cost=10.0, scan_done=True, impression_cost=0.0)])
    assert summary.steps_total == 2
    assert summary.steps_done == 1


def test_step_counters_ignore_done_flags_on_unpriced_services():
    # A done flag on a service with no cost is not a step at all.
    summary = summarise([_Task(usinage_done=True)])
    assert summary.steps_total == 0
    assert summary.steps_done == 0


def test_step_counters_sum_across_tasks():
    summary = summarise(
        [
            _Task(scan_cost=1.0, scan_done=True, modelisation_cost=2.0, modelisation_done=True, impression_cost=3.0),
            _Task(impression_cost=4.0, impression_done=True, usinage_cost=5.0),
            _Task(scan_cost=6.0, modelisation_cost=7.0, impression_cost=8.0, usinage_cost=9.0),
        ]
    )
    assert summary.steps_total == 9
    assert summary.steps_done == 3


def test_empty_summary_has_zero_steps():
    assert summarise([]).steps_total == 0
    assert summarise([]).steps_done == 0


def test_to_response_carries_the_step_counters():
    """The card's progress bar reads these; a handler that dropped them would
    render every bar at zero with nothing failing."""
    from backend.app.api.routes.aito import _to_response
    from backend.app.models.aito_project import AitoProject

    project = AitoProject(
        id=1,
        description="x",
        board_column="print",
        position=0,
        status="active",
        quote_status="accepted",
        # AitoProject.created_at/updated_at carry only a server_default, so an
        # in-memory instance that never went through a DB flush leaves them
        # None; AitoProjectResponse requires real datetimes.
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    summary = summarise([_Task(scan_cost=1.0, scan_done=True, impression_cost=2.0)])
    response = _to_response(project, summary, {})  # no shipment on this in-memory project
    assert response.steps_total == 2
    assert response.steps_done == 1


def test_to_response_carries_the_pending_services():
    """evaluate() takes `pending`, so an optimistic client that only had
    `task_services` would have to guess which of them are still unticked."""
    from backend.app.api.routes.aito import _to_response
    from backend.app.models.aito_project import AitoProject

    project = AitoProject(
        id=1,
        description="x",
        board_column="print",
        position=0,
        status="active",
        quote_status="accepted",
        # AitoProject.created_at/updated_at carry only a server_default, so an
        # in-memory instance that never went through a DB flush leaves them
        # None; AitoProjectResponse requires real datetimes.
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    summary = summarise([_Task(scan_cost=1.0, scan_done=True, impression_cost=2.0)])
    response = _to_response(project, summary, {})  # no shipment on this in-memory project
    assert response.task_services == ["scan", "impression"]
    assert response.task_pending == ["impression"]


def test_steps_by_task_is_empty_for_no_tasks():
    assert summarise([]).steps_by_task == ()


def test_steps_by_task_has_one_entry_per_task_even_when_unpriced():
    """A task with nothing priced still owns a row on the card — an empty one."""
    summary = summarise([_Task(), _Task(scan_cost=1)])
    assert summary.steps_by_task == (
        TaskSteps(services=(), done=()),
        TaskSteps(services=("scan",), done=()),
    )


def test_steps_by_task_lists_services_in_canonical_order_not_field_order():
    summary = summarise([_Task(usinage_cost=1, scan_cost=2, impression_cost=3)])
    assert summary.steps_by_task == (TaskSteps(services=("scan", "impression", "usinage"), done=()),)


def test_a_free_step_is_in_steps_by_task():
    """0 is quoted free and is a real step; None is absent from the job."""
    summary = summarise([_Task(modelisation_cost=0.0)])
    assert summary.steps_by_task == (TaskSteps(services=("modelisation",), done=()),)


def test_done_lists_only_ticked_priced_services():
    """A done flag on an unpriced service is not a step and must not appear."""
    summary = summarise([_Task(scan_cost=1, scan_done=True, usinage_done=True, impression_cost=2)])
    assert summary.steps_by_task == (TaskSteps(services=("scan", "impression"), done=("scan",)),)


def test_steps_by_task_preserves_task_order():
    """The card's rows must line up with the detail panel's, which is the
    order the caller hands them in."""
    summary = summarise([_Task(impression_cost=1), _Task(scan_cost=1, scan_done=True)])
    assert summary.steps_by_task == (
        TaskSteps(services=("impression",), done=()),
        TaskSteps(services=("scan",), done=("scan",)),
    )
