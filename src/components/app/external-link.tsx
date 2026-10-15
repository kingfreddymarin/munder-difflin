// Opens a GitHub / Azure DevOps / log URL outside the app. In Electron the window-open handler hands
// http(s) to the system browser; anything else is shown as plain text with the reason, never a dead link.
// Lane A ships the shared ExternalLink with the same props (`href`, `label`); this one is replaced by it.
import { cn } from '@/lib/utils';

const openable = (href: string) => /^https?:\/\//i.test(href);

export function ExternalLink({ href, label, className }: { href: string; label: string; className?: string }) {
  if (!openable(href)) {
    return <span className={cn('text-muted-foreground cursor-not-allowed text-sm', className)} title={href ? `Not a web link: ${href}` : 'The core sent no link for this'}>{label}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={href} className={cn('text-primary text-sm hover:underline', className)}>
      {label} ↗
    </a>
  );
}
