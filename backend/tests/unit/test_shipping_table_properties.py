"""The island/service lookup table is data, and data rots silently.

These are universals over the whole table rather than examples: a new island
added with a typo'd service key, or a duplicated label, fails here rather than
at a freight counter.
"""

from hypothesis import given, strategies as st

from backend.app.services.aito_shipping import (
    ISLANDS,
    SERVICE_KEYS,
    SERVICE_LABELS,
    grouped_islands,
    service_for_island,
)

ISLAND_KEYS = [key for key, _label, _service in ISLANDS]


def test_every_island_resolves_to_a_known_service():
    for key, _label, service in ISLANDS:
        assert service in SERVICE_KEYS, f"{key} names unknown service {service!r}"
        assert service_for_island(key) == service


def test_island_keys_and_labels_are_unique():
    assert len(ISLAND_KEYS) == len(set(ISLAND_KEYS))
    labels = [label for _key, label, _service in ISLANDS]
    assert len(labels) == len(set(labels))


def test_every_service_has_a_label_and_at_least_one_island():
    grouped = dict(grouped_islands())
    for service in SERVICE_KEYS:
        assert service in SERVICE_LABELS
        assert grouped.get(service), f"{service} has no islands"


@given(st.sampled_from(ISLAND_KEYS))
def test_service_for_island_is_total_over_the_table(key: str):
    assert service_for_island(key) is not None


@given(st.text(max_size=60))
def test_service_for_island_never_raises_on_arbitrary_input(value: str):
    # Route handlers pass user-supplied island keys straight in; an exception
    # here would be a 500 instead of the documented 422.
    assert service_for_island(value) is None or service_for_island(value) in SERVICE_KEYS
