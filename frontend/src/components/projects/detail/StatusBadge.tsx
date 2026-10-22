type TFunction = (key: string, options?: Record<string, unknown>) => string;

export function StatusBadge({ status, t }: { status: string; t: TFunction }) {
  const colors = {
    active: 'bg-bambu-green/20 text-bambu-green',
    completed: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400',
    archived: 'bg-bambu-gray/20 text-bambu-gray',
  };
  const color = colors[status as keyof typeof colors] || colors.active;

  const labels: Record<string, string> = {
    active: t('projectDetail.status.active'),
    completed: t('projectDetail.status.completed'),
    archived: t('projectDetail.status.archived'),
  };

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {labels[status] || status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
