// "See all" pattern: panels show what fits; the rest opens in a sheet. No page ever scrolls.
import * as React from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/animate-ui/components/radix/sheet';
import { Button } from '@/components/animate-ui/components/buttons/button';

export function SeeAll({ title, description, count, children }: { title: string; description?: string; count: number; children: React.ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
          See all ({count})
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[440px] sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
