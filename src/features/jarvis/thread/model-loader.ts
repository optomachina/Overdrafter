// Keep the web component and its renderer out of the initial thread chunk.
export const loadModelViewer = () => import('@google/model-viewer');
