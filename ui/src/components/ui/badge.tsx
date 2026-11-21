import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'text-foreground',
      success: 'border-transparent bg-emerald-500/15 text-emerald-400',
      warning: 'border-transparent bg-amber-500/15 text-amber-400',
      danger: 'border-transparent bg-rose-500/15 text-rose-400',
      info: 'border-transparent bg-sky-500/15 text-sky-300',
      violet: 'border-transparent bg-violet-500/15 text-violet-300',
    },
  },
  defaultVariants: { variant: 'secondary' },
});

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
