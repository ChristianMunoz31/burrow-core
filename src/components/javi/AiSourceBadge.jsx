import { Cloud, Cpu, Network } from 'lucide-react';

const SOURCES = {
  cloud: { Icon: Cloud, text: (host) => `Cloud: ${host ?? 'your provider'}` },
  lan: { Icon: Network, text: (host) => `On your network: ${host ?? 'another computer'}` },
  local: { Icon: Cpu, text: () => 'On this computer' },
};

/**
 * Small label that says where Javi's answer is computed. Renders nothing without a source.
 * @param {{ ai?: { kind: 'local'|'lan'|'cloud', host: string|null } | null, className?: string, id?: string }} props
 */
export default function AiSourceBadge({ ai, className = '', id }) {
  const source = ai ? SOURCES[ai.kind] : null;
  if (!source) return null;
  const { Icon } = source;
  const text = source.text(ai.host);
  return (
    <span
      id={id}
      data-ai-kind={ai.kind}
      title={text}
      className={`inline-flex max-w-full items-center gap-1 text-[11px] text-slate-slate300 ${className}`}
    >
      <Icon size={11} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}
