from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base

# Timestamps are aware ISO strings (not DateTime): the sync plan parses them back and subtracts them from an aware now.


class RevenueDay(Base):
    """One org calendar day of the Zoho salesbyitem report; a day with no sales still has its row."""

    __tablename__ = "revenue_days"

    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    closed: Mapped[bool] = mapped_column(Boolean)
    fetched_at: Mapped[str] = mapped_column(String(40))
    format: Mapped[int] = mapped_column(Integer)


class RevenueDayLine(Base):
    """customer_id is "" when Zoho gave none: primary key columns cannot be NULL."""

    __tablename__ = "revenue_day_lines"

    day: Mapped[str] = mapped_column(String(10), ForeignKey("revenue_days.day", ondelete="CASCADE"), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), primary_key=True, index=True)
    customer_id: Mapped[str] = mapped_column(String(64), primary_key=True, default="", index=True)
    name: Mapped[str] = mapped_column(String(500))
    sku: Mapped[str] = mapped_column(String(255), default="")
    quantity: Mapped[float] = mapped_column(Float)
    amount: Mapped[float] = mapped_column(Float)
    # Frozen at fetch so a later price change leaves past margins alone; NULL on days cached before.
    unit_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    tax_percentage: Mapped[float | None] = mapped_column(Float, nullable=True)


class RevenueCustomer(Base):
    __tablename__ = "revenue_customers"

    customer_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(500), default="")
    company_name: Mapped[str] = mapped_column(String(500), default="")
    sub_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    found: Mapped[bool] = mapped_column(Boolean)
    fetched_at: Mapped[str] = mapped_column(String(40))


class RevenueScopeDecision(Base):
    __tablename__ = "revenue_scope_decisions"

    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    included: Mapped[bool] = mapped_column(Boolean)
    decided_at: Mapped[str] = mapped_column(String(40))


class RevenueTarget(Base):
    __tablename__ = "revenue_targets"

    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    amount_ht: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[str] = mapped_column(String(40))


class RevenueAnnotation(Base):
    __tablename__ = "revenue_annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    day: Mapped[str] = mapped_column(String(10))
    label: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[str] = mapped_column(String(40))


class RevenueItem(Base):
    """Zoho item facts the scope rules need, refreshed in full by the sync."""

    __tablename__ = "revenue_items"

    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(500), default="")
    sku: Mapped[str] = mapped_column(String(255), default="")
    brand: Mapped[str | None] = mapped_column(String(255), nullable=True)
    nature: Mapped[str | None] = mapped_column(String(255), nullable=True)  # cf_nature_du_produit
    item_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    tax_percentage: Mapped[float | None] = mapped_column(Float, nullable=True)
    purchase_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    dealer_price: Mapped[float | None] = mapped_column(Float, nullable=True)  # cf_prix_dealer_usd_unformatted
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fetched_at: Mapped[str] = mapped_column(String(40))


class RevenueMonthCheck(Base):
    """A closed month's cached total against Zoho's own salesbyitem total for the same window."""

    __tablename__ = "revenue_month_checks"

    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    zoho_amount: Mapped[float] = mapped_column(Float)
    cache_amount: Mapped[float] = mapped_column(Float)
    checked_at: Mapped[str] = mapped_column(String(40))


class RevenuePayment(Base):
    """A Zoho customer payment; `applications` ([{invoiceId, amount}]) is read only for customers the cache cannot classify."""

    __tablename__ = "revenue_payments"

    payment_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    customer_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    amount: Mapped[float] = mapped_column(Float)
    unapplied: Mapped[float] = mapped_column(Float, default=0.0)
    applications: Mapped[list | None] = mapped_column(JSON(none_as_null=True), nullable=True)
    last_modified_time: Mapped[str] = mapped_column(String(40), default="")
    fetched_at: Mapped[str] = mapped_column(String(40))


class RevenueInvoiceShare(Base):
    """An invoice's balance and its 3D share of HT; `share` is NULL until the invoice is read, and read again when
    Zoho's total moves away from `share_total`."""

    __tablename__ = "revenue_invoice_shares"

    invoice_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    number: Mapped[str] = mapped_column(String(100), default="")
    customer_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    customer_name: Mapped[str] = mapped_column(String(500), default="")
    date: Mapped[str] = mapped_column(String(10), default="")
    due_date: Mapped[str] = mapped_column(String(10), default="")
    total: Mapped[float] = mapped_column(Float, default=0.0)
    balance: Mapped[float] = mapped_column(Float, default=0.0)
    share: Mapped[float | None] = mapped_column(Float, nullable=True)
    share_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    fetched_at: Mapped[str] = mapped_column(String(40))
