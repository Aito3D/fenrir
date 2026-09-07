"""Hypothesis settings for this suite.

`deadline=None` on purpose: the suite runs under `pytest-xdist` with up to 30
workers, so a per-example wall-clock deadline measures machine contention
rather than the code under test and turns every loaded CI run into a flake.
Bounded instead by `max_examples`, which is deterministic.

`derandomize=True` makes every run use the same examples, so a property that
passes locally cannot fail in CI on a different draw — the same reason every
fast-check property in this campaign passes an explicit seed.
"""

from hypothesis import HealthCheck, settings

settings.register_profile(
    "ci",
    max_examples=200,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.too_slow],
)
settings.load_profile("ci")
