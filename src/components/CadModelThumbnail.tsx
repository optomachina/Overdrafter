import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Box, Loader2, Rotate3D } from "lucide-react";
import type { OcctMesh } from "occt-import-js";
import { isStepPreviewableFile, loadCadPreview, type CadPreviewSource } from "@/lib/cad-preview";
import { cn } from "@/lib/utils";

type PreviewStatus = "loading" | "ready" | "error";

interface CadModelThumbnailProps {
  source: CadPreviewSource;
  className?: string;
}

export function CadModelThumbnail({ source, className }: CadModelThumbnailProps) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const previewable = useMemo(() => isStepPreviewableFile(source.fileName), [source.fileName]);
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const host = canvasHostRef.current;

    if (!host || !previewable) {
      setStatus("error");
      setErrorMessage("Preview only supports STEP files.");
      return;
    }

    let animationFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let disposed = false;
    let renderer:
      | {
          render: () => void;
          dispose: () => void;
          domElement: HTMLCanvasElement;
        }
      | undefined;
    let controls:
      | {
          update: () => void;
          dispose: () => void;
        }
      | undefined;
    let scene:
      | {
          traverse: (callback: (node: { geometry?: { dispose?: () => void }; material?: unknown }) => void) => void;
        }
      | undefined;

    host.replaceChildren();
    setStatus("loading");
    setErrorMessage(null);

    void (async () => {
      try {
        const [{ OrbitControls }, THREE, result] = await Promise.all([
          import("three/examples/jsm/controls/OrbitControls.js"),
          import("three"),
          loadCadPreview(source),
        ]);

        if (disposed || !canvasHostRef.current) {
          return;
        }

        const nextRenderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        });
        nextRenderer.setClearColor(0x000000, 0);
        nextRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        nextRenderer.outputColorSpace = THREE.SRGBColorSpace;
        nextRenderer.sortObjects = true;

        const nextScene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(24, 1, 0.01, 10_000);
        const nextControls = new OrbitControls(camera, nextRenderer.domElement);
        const modelGroup = new THREE.Group();

        const ambientLight = new THREE.HemisphereLight(0xf8fbff, 0x213047, 1.7);
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
        keyLight.position.set(5, 8, 9);
        const fillLight = new THREE.DirectionalLight(0xb7d4ff, 0.55);
        fillLight.position.set(-4, 1.5, -6);

        nextScene.add(ambientLight, keyLight, fillLight, modelGroup);

        const bodyMaterial = new THREE.MeshStandardMaterial({
          color: 0xe8edf3,
          metalness: 0.05,
          roughness: 0.82,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        const edgeMaterial = new THREE.LineBasicMaterial({
          color: 0x0f1724,
          transparent: true,
          opacity: 0.5,
        });

        for (const mesh of result.meshes) {
          appendPreviewMesh(THREE, modelGroup, mesh, bodyMaterial, edgeMaterial);
        }
        bodyMaterial.dispose();
        edgeMaterial.dispose();

        const bounds = new THREE.Box3().setFromObject(modelGroup);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z, 1);

        modelGroup.position.sub(center);
        modelGroup.position.y += maxDimension * 0.06;

        const shadow = new THREE.Mesh(
          new THREE.CircleGeometry(maxDimension * 0.62, 48),
          new THREE.MeshBasicMaterial({
            color: 0x06101d,
            transparent: true,
            opacity: 0.14,
          }),
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = -size.y * 0.58;
        shadow.scale.set(1.35, 0.78, 1);
        nextScene.add(shadow);

        const distance = maxDimension * 2.3;
        camera.position.set(distance, distance * 0.82, distance * 1.15);
        camera.near = Math.max(maxDimension / 200, 0.01);
        camera.far = maxDimension * 20;
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();

        nextControls.enableDamping = true;
        nextControls.enablePan = false;
        nextControls.minDistance = maxDimension * 0.7;
        nextControls.maxDistance = maxDimension * 5;
        nextControls.autoRotate = true;
        nextControls.autoRotateSpeed = 2;
        nextControls.target.set(0, 0, 0);
        nextControls.update();

        const resizeRenderer = () => {
          const width = canvasHostRef.current?.clientWidth ?? 0;
          const height = canvasHostRef.current?.clientHeight ?? 0;

          if (width === 0 || height === 0) {
            return;
          }

          nextRenderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };

        resizeRenderer();
        canvasHostRef.current.replaceChildren(nextRenderer.domElement);
        resizeObserver = new ResizeObserver(() => {
          resizeRenderer();
        });
        resizeObserver.observe(canvasHostRef.current);

        const renderFrame = () => {
          nextControls.update();
          nextRenderer.render(nextScene, camera);
          animationFrame = window.requestAnimationFrame(renderFrame);
        };

        renderer = nextRenderer;
        controls = nextControls;
        scene = nextScene;
        setStatus("ready");
        renderFrame();
      } catch (error) {
        if (disposed) {
          return;
        }

        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Preview failed to load.");
      }
    })();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      controls?.dispose();

      scene?.traverse((node) => {
        node.geometry?.dispose?.();

        if (Array.isArray(node.material)) {
          node.material.forEach((material) => {
            disposeThreeResource(material);
          });
        } else {
          disposeThreeResource(node.material);
        }
      });

      renderer?.dispose();
      host.replaceChildren();
    };
  }, [previewable, source, source.cacheKey, source.fileName]);

  return (
    <div
      aria-label={`CAD preview for ${source.fileName}`}
      className={cn(
        "relative isolate overflow-hidden rounded-surface-lg border border-white/12 bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.18),transparent_52%),linear-gradient(180deg,rgba(255,255,255,0.16),rgba(7,11,18,0.92))] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
        className,
      )}
    >
      <div ref={canvasHostRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-2">
        <div className="rounded-full border border-white/15 bg-black/25 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.24em] text-white/75">
          STEP
        </div>
        <div className="rounded-full border border-white/12 bg-black/20 px-2 py-1 text-[11px] text-white/55">
          Hidden lines removed
        </div>
      </div>

      {status !== "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/25 text-center text-white/75">
          {status === "loading" ? (
            <>
              <div className="rounded-full border border-white/12 bg-black/20 p-3">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">Generating preview</p>
                <p className="mt-1 text-xs text-white/50">Meshing the STEP file locally in your browser.</p>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-full border border-amber-400/20 bg-amber-500/10 p-3 text-amber-200">
                <AlertCircle className="h-6 w-6" />
              </div>
              <div className="max-w-[12rem] px-3">
                <p className="text-sm font-medium">Preview unavailable</p>
                <p className="mt-1 text-xs text-white/50">
                  {errorMessage ?? "This STEP file could not be rendered into a thumbnail."}
                </p>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between p-3 text-[11px] text-white/55">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-black/20 px-2 py-1">
          <Rotate3D className="h-3.5 w-3.5" />
          Drag to inspect
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-black/20 px-2 py-1">
          <Box className="h-3.5 w-3.5" />
          Live 3D
        </div>
      </div>
    </div>
  );
}

function appendPreviewMesh(
  THREE: typeof import("three"),
  target: InstanceType<typeof import("three")["Group"]>,
  mesh: OcctMesh,
  bodyMaterial: InstanceType<typeof import("three")["MeshStandardMaterial"]>,
  edgeMaterial: InstanceType<typeof import("three")["LineBasicMaterial"]>,
) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
  geometry.setIndex(mesh.index.array);

  if (mesh.attributes.normal?.array?.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
  } else {
    geometry.computeVertexNormals();
  }

  const body = new THREE.Mesh(geometry, bodyMaterial.clone());
  body.renderOrder = 1;
  target.add(body);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 32),
    edgeMaterial.clone(),
  );
  edges.renderOrder = 2;
  target.add(edges);
}

function disposeThreeResource(resource: unknown) {
  if (!resource || typeof resource !== "object" || !("dispose" in resource)) {
    return;
  }

  const disposable = resource as { dispose?: () => void };

  if (typeof disposable.dispose === "function") {
    disposable.dispose();
  }
}
