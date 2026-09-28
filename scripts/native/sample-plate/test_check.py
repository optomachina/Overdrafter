import math
import unittest
from check import geometry


class Face:
    def __init__(self, params=None):
        self.params = params

    def GetSurface(self):
        return self

    def IsCylinder(self):
        return self.params is not None

    @property
    def CylinderParams(self):
        return self.params

    def GetBox(self):
        x, _, z, _, _, _, r = self.params
        return [x-r, 0, z-r, x+r, .00635, z+r]


class Body:
    def __init__(self):
        self.faces = [Face() for _ in range(6)] + [Face([x, 0, z, 0, 1, 0, radius])
            for radius in [.0127, .0025527] for x in [-.0381, .0381] for z in [-.0381, .0381]]
        self.volume = (.1016**2 - (4-math.pi)*.0127**2 - 4*math.pi*.0025527**2)*.00635

    def GetFaces(self):
        return self.faces

    def GetMassProperties(self, _density):
        return [0, 0, 0, self.volume]

    def Check2(self):
        return 0


class Ops:
    def __init__(self, body):
        self.body = body

    def shape(self, _document):
        return None, self.body, [-.0508, 0, -.0508, .0508, .00635, .0508]

    def cast(self, obj, _type):
        return obj


class GeometryContract(unittest.TestCase):
    def test_exact_plate(self):
        checks, _ = geometry(None, Ops(Body()))
        self.assertTrue(all(checks.values()))

    def test_extra_center_hole_rejected(self):
        body = Body()
        body.faces.append(Face([0, 0, 0, 0, 1, 0, .003]))
        checks, _ = geometry(None, Ops(body))
        self.assertFalse(checks['holes'])

    def test_unexpected_removed_volume_rejected(self):
        body = Body()
        body.volume -= 1e-8
        checks, _ = geometry(None, Ops(body))
        self.assertFalse(checks['holes'])

    def test_misplaced_hole_rejected(self):
        body = Body()
        body.faces[-1].params[0] += .001
        checks, _ = geometry(None, Ops(body))
        self.assertFalse(checks['holes'])


if __name__ == '__main__':
    unittest.main()
