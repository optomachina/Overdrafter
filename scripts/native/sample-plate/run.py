"""One bounded, non-retrying sample operation on the retained SW2022 process."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import psutil
import win32api
import win32event
import winerror
from check import geometry, native


def load_helper(file):
    spec = importlib.util.spec_from_file_location('plate_ops', file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def documents(app, ops):
    result = []
    doc = app.GetFirstDocument()
    while doc:
        doc = ops.cast(doc, 'IModelDoc2')
        result.append({'title': doc.GetTitle(), 'path': doc.GetPathName(), 'dirty': bool(doc.GetSaveFlag())})
        doc = doc.GetNext()
    return sorted(result, key=lambda d: (d['path'], d['title']))


def main(payload):
    began = time.perf_counter()
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != payload['nativeHash'] or hashlib.sha256(Path(__file__).with_name('check.py').read_bytes()).hexdigest() != payload['checkerHash']:
        raise RuntimeError('Native implementation changed after launch')
    helper = Path(payload['helper']).resolve()
    if hashlib.sha256(helper.read_bytes()).hexdigest() != payload['helperHash']:
        raise RuntimeError('Helper changed')
    process = psutil.Process(payload['pid'])
    if process.name().lower() != 'sldworks.exe' or abs(process.create_time() - payload['processStarted']) > 0.01:
        raise RuntimeError('Retained SolidWorks process changed')
    output = Path(payload['output']).resolve()
    output.mkdir(parents=False, exist_ok=False)
    mutex = win32event.CreateMutex(None, True, 'Local\\OverDrafterSamplePlateSW2022')
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        win32api.CloseHandle(mutex)
        raise RuntimeError('Another sample native owner exists')
    ops = load_helper(helper)
    app = ops.connect()
    if app.GetProcessID() != payload['pid']:
        raise RuntimeError('ROT process mismatch')
    before = documents(app, ops)
    if any(row['title'].lower() in ('plate', 'plate.sldprt', 'plate.step') for row in before):
        raise RuntimeError('A pre-existing document conflicts with the sample filename')
    active = ops.cast(app.ActiveDoc, 'IModelDoc2').GetTitle() if app.ActiveDoc else None
    owned = None
    native_path = output / 'plate.SLDPRT'
    step_path = output / 'plate.STEP'
    receipt = {'pid': payload['pid'], 'processStarted': payload['processStarted'], 'before': before, 'helperHash': payload['helperHash'], 'nativeHash': payload['nativeHash'], 'checkerHash': payload['checkerHash']}
    restored = False

    def restore_active():
        if not active:
            return
        restored_doc, errors = app.ActivateDoc3(active, False, 1, 0)  # swDontRebuildActiveDoc
        if errors != 0 or restored_doc is None or ops.cast(restored_doc, 'IModelDoc2').GetTitle() != active:
            raise RuntimeError('Original active document restoration failed')

    def record():
        with (output / 'native-receipt.json').open('w') as stream:
            json.dump(receipt, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())

    record()
    try:
        raw = app.NewDocument(r'C:\ProgramData\SOLIDWORKS\SOLIDWORKS 2022\User Assets\Part.PRTDOT', 0, 0, 0)
        if raw is None:
            raise RuntimeError('No new part')
        doc = ops.cast(raw, 'IModelDoc2')
        owned = doc.GetTitle()
        if any(row['title'] == owned for row in before):
            owned = None
            raise RuntimeError('New document identity collision')
        receipt['createdTitle'] = owned
        record()
        if not doc.Extension.SelectByID2('Top', 'PLANE', 0, 0, 0, False, 0, None, 0):
            raise RuntimeError('Missing template Top plane')
        sketch = doc.SketchManager
        sketch.InsertSketch(True)
        sketch.CreateCenterRectangle(0, 0, 0, .0508, .0508, 0)
        sketch.InsertSketch(True)
        feature = doc.FeatureManager.FeatureExtrusion2(True, False, False, 0, 0, .00635, .00635,
            False, False, False, False, 0, 0, False, False, False, False, True, True, True, 0, 0, False)
        if feature is None:
            raise RuntimeError('Plate extrusion failed')
        result = doc.Extension.SaveAs(str(native_path), 0, 1, None, 0, 0)
        owned = doc.GetTitle()
        if not result[0] or result[1] != 0:
            raise RuntimeError('Initial native save failed')
        ops.finish_plate(str(native_path), ['corners', 'taps', 'material', 'save'], str(native_path))
        owned = doc.GetTitle()
        app.CloseDoc(owned)
        owned = None
        print('PLATE_VERIFYING', file=sys.stderr, flush=True)
        loaded = app.OpenDoc6(str(native_path), 1, 1, '', 0, 0)
        if loaded[0] is None or loaded[1] != 0:
            raise RuntimeError('Native reopen failed')
        doc = ops.cast(loaded[0], 'IModelDoc2')
        owned = doc.GetTitle()
        checks, evidence = native(doc, ops)
        app.CloseDoc(owned)
        owned = None
        loaded_step = app.LoadFile4(str(step_path), 'r', None, 0)
        receipt['stepImportErrors'] = loaded_step[1] if isinstance(loaded_step, tuple) else None
        record()
        if not isinstance(loaded_step, tuple) or len(loaded_step) != 2 or loaded_step[1] != 0:
            raise RuntimeError('STEP import returned errors')
        raw_step = loaded_step[0]
        if raw_step is None:
            raise RuntimeError('STEP independent import failed')
        step_doc = ops.cast(raw_step, 'IModelDoc2')
        owned = step_doc.GetTitle()
        if any(row['title'] == owned for row in before):
            owned = None
            raise RuntimeError('STEP identity collision')
        step_checks, step_evidence = geometry(step_doc, ops)
        checks.update({'stepDimensions': step_checks['dimensions'], 'stepHoles': step_checks['holes'], 'stepCorners': step_checks['corners']})
        app.CloseDoc(owned)
        owned = None
        restore_active()
        restored = True
        after = documents(app, ops)
        checks['documentsPreserved'] = before == after
        files = [{'name': p.name, 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in [native_path, step_path]]
        result = {'checks': checks, 'files': files, 'material': evidence['material'], 'elapsedSeconds': time.perf_counter() - began, 'documentsPreserved': checks['documentsPreserved']}
        receipt.update({'after': after, 'native': evidence, 'step': step_evidence, 'result': result})
        record()
        return result
    finally:
        # Only a document created/opened by this operation may be closed. Never
        # close pre-existing parts or kill the application on error/timeout.
        if owned and not any(row['title'] == owned for row in before):
            app.CloseDoc(owned)
        if not restored:
            restore_active()
        win32event.ReleaseMutex(mutex)
        win32api.CloseHandle(mutex)


if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'status': 'unknown; inspect native receipt, never automatically retry'}))
        sys.exit(1)
