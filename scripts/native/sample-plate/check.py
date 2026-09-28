"""Independent saved-document inspection; never consumes build success flags."""
import math


def geometry(document, ops):
    _, body, box = ops.shape(document)
    extents = sorted((box[i + 3] - box[i]) * 1000 for i in range(3))
    axis = min(range(3), key=lambda i: box[i + 3] - box[i])
    axes = [i for i in range(3) if i != axis]
    center = [(box[i] + box[i + 3]) / 2 for i in range(3)]
    cylinders = []
    faces = body.GetFaces()
    for face_raw in faces:
        face = ops.cast(face_raw, 'IFace2')
        surface = ops.cast(face.GetSurface(), 'ISurface')
        if surface.IsCylinder():
            cylinders.append((list(surface.CylinderParams), list(face.GetBox())))
    expected = [(-38.1, -38.1), (-38.1, 38.1), (38.1, -38.1), (38.1, 38.1)]

    def pattern(radius):
        selected = [(p, b) for p, b in cylinders if abs(p[6] * 1000 - radius) < 0.001]
        positions = sorted(tuple(round((p[i] - center[i]) * 1000, 3) for i in axes) for p, _ in selected)
        return len(selected) == 4 and positions == expected and all(
            abs(abs(p[3 + axis]) - 1) < 1e-6
            and abs(b[axis] - box[axis]) < 1e-5
            and abs(b[axis + 3] - box[axis + 3]) < 1e-5 for p, b in selected)

    volume = body.GetMassProperties(1)[3]
    expected_volume = (.1016 ** 2 - (4 - math.pi) * .0127 ** 2 - 4 * math.pi * .0025527 ** 2) * .00635
    exact_solid = (len(faces) == 14 and len(cylinders) == 8 and body.Check2() == 0
                   and math.isclose(volume, expected_volume, rel_tol=1e-7, abs_tol=1e-12))
    return {'dimensions': all(math.isclose(a, b, abs_tol=0.002) for a, b in zip(extents, [6.35, 101.6, 101.6])),
            'holes': pattern(2.5527) and exact_solid, 'corners': pattern(12.7) and exact_solid}, {
                'extents_mm': extents, 'cylinders': cylinders, 'face_count': len(faces),
                'body_check': body.Check2(), 'volume_m3': volume, 'expected_volume_m3': expected_volume}


def native(document, ops):
    checks, evidence = geometry(document, ops)
    part = ops.cast(document, 'IPartDoc')
    material = part.GetMaterialPropertyName2('')[0]
    checks['material'] = material == '6061 Alloy'
    features = []
    feature = document.FirstFeature()
    while feature:
        feature = ops.cast(feature, 'IFeature')
        if feature.GetTypeName2() == 'HoleWzd':
            data = ops.cast(feature.GetDefinition(), 'IWizardHoleFeatureData2')
            features.append({k: getattr(data, k) for k in ['FastenerSize', 'ThreadClass', 'EndCondition', 'ThreadEndCondition']})
        feature = feature.GetNextFeature()
    expected = {'FastenerSize': '1/4-20', 'ThreadClass': '2B', 'EndCondition': 1, 'ThreadEndCondition': 1}
    checks['threadMetadata'] = len(features) == 4 and all(item == expected for item in features)
    evidence['thread_features'] = features
    evidence['material'] = material
    return checks, evidence
