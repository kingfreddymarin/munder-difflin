import * as React from 'react';
import { Screen } from '@/components/app/screen';
import { FileViewerFeature } from '@/features/files/file-viewer';

export function FilesPage() {
  return (
    <Screen fill>
      <div className="flex shrink-0 flex-col">
        <h1 className="text-xl font-semibold tracking-tight">Files</h1>
        <span className="text-muted-foreground text-xs">Open a folder or file to view and edit</span>
      </div>
      <FileViewerFeature />
    </Screen>
  );
}
