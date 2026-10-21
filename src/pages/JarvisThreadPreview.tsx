import { useMemo } from 'react';
import { JarvisThread } from '@/features/jarvis/thread/JarvisThread';
import { createPreview } from '@/features/jarvis/thread/preview-source';

export default function JarvisThreadPreview() {
  const preview = useMemo(createPreview, []);
  return <><p style={{ background: '#0e0e10', color: '#a3a3aa', textAlign: 'center', margin: 0, padding: 8 }}>SAMPLE DATA</p><JarvisThread {...preview} runId="plate-preview" workingName="PLATE R1" /></>;
}
