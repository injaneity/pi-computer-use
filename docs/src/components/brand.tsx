export function Brand() {
  return (
    <span className="quiet-brand" aria-label="pi-computer-use documentation">
      <svg className="quiet-brand-mark" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="1.5" y="1.5" width="25" height="25" />
        <path className="quiet-brand-brackets" d="M6 11V6h5M22 17v5h-5" />
        <circle cx="12" cy="12" r="2.25" />
        <path className="quiet-brand-action" d="M7 20h7.5l3-3m-3 3 3 3" />
      </svg>
      <span>
        <strong>pi-computer-use</strong>
        <small>technical documentation</small>
      </span>
    </span>
  );
}

export function DocsFooter() {
  return (
    <div className="quiet-sidebar-footer">
      <span><i className="signal signal-live" /> documentation online</span>
      <span>pi-computer-use / mit</span>
    </div>
  );
}

