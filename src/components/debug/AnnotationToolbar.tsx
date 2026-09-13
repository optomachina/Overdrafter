import { Agentation } from "agentation";
import { useRef, type KeyboardEvent } from "react";

const toolbarClass = "overdrafter-annotation-toolbar";

/** Restricts the bridge to the focused, non-native launcher in our toolbar. */
function launcherFor(event: KeyboardEvent<HTMLDivElement>): HTMLDivElement | null {
  const target = event.target;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.nativeEvent.isComposing || !(target instanceof HTMLDivElement)
    || target !== document.activeElement || target.isContentEditable
    || !target.matches('[role="button"][tabindex="0"]')
    || !target.closest(`.${toolbarClass}`)) {
    return null;
  }
  return target;
}

/** Adds keyboard button behavior through React portal bubbling and Agentation's public class hook. */
export function AnnotationToolbar() {
  const spaceTarget = useRef<HTMLDivElement | null>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") {
      spaceTarget.current = null;
      return;
    }
    const launcher = launcherFor(event);
    if (!launcher) {
      spaceTarget.current = null;
      return;
    }
    event.preventDefault();
    if (event.repeat) return;
    if (event.key === "Enter") {
      spaceTarget.current = null;
      launcher.click();
    } else {
      spaceTarget.current = launcher;
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== " ") return;
    const pressed = spaceTarget.current;
    spaceTarget.current = null;
    if (pressed && pressed.isConnected && launcherFor(event) === pressed) {
      event.preventDefault();
      pressed.click();
    }
  }

  // React owns these handlers, including portal events; unmount removes the bridge.
  return <div className="contents" onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}
    onBlur={() => { spaceTarget.current = null; }}>
    <Agentation className={toolbarClass} />
  </div>;
}
