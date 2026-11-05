const VARIANT_CLASS = {
  default: 'glass',
  dense: 'glass-dense',
};

export default function SectionCard({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
  className = '',
  variant = 'default',
  id,
  headingId,
}) {
  return (
    <div
      id={id}
      className={`${VARIANT_CLASS[variant] ?? VARIANT_CLASS.default} rounded-2xl p-5 ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={16} className="text-slate-slate400" />}
            <div className="min-w-0">
              {title && (
                <h3
                  id={headingId}
                  tabIndex={headingId ? -1 : undefined}
                  className="text-sm font-bold text-slate-slate100 tracking-tight truncate focus:outline-none"
                >
                  {title}
                </h3>
              )}
              {subtitle && <p className="text-xs text-slate-slate400 mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
