"""Behavior checks for barcode compatibility and multiple inventory identifiers."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
import zxingcpp

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ocr-service"))
import barcode_reader


def barcode_image(value, kind):
    encoded = zxingcpp.create_barcode(value, kind)
    return Image.fromarray(np.asarray(zxingcpp.write_barcode_to_image(encoded, scale=3))).convert("RGB")


class BarcodeReaderTests(unittest.TestCase):
    def test_code128_is_returned_without_claiming_it_is_a_serial_or_database_match(self):
        result = barcode_reader.decode_barcode(barcode_image("TEST-ASSET-001", zxingcpp.BarcodeFormat.Code128))
        self.assertTrue(result["success"])
        self.assertEqual(result["barcode"], "TEST-ASSET-001")
        self.assertEqual(result["type"], "CODE_128")
        self.assertFalse(result["matched"])
        self.assertIsNone(result["record"])
        self.assertNotIn("serial", result)
        self.assertNotIn("hardwareId", result)

    def test_qr_payload_is_preserved_without_executing_or_reclassifying_its_content(self):
        value = "https://example.invalid/item?id=123"
        result = barcode_reader.decode_barcode(barcode_image(value, zxingcpp.BarcodeFormat.QRCode))
        self.assertEqual(result["barcode"], value)
        self.assertEqual(result["type"], "QR_CODE")

    def test_large_scene_finds_identifiers_in_different_regions_and_maps_original_coordinates(self):
        for left, top in [(80, 80), (1700, 1200)]:
            with self.subTest(left=left, top=top):
                image = Image.new("RGB", (3000, 2000), "#333333")
                code = barcode_image("TEST-SERIAL-002", zxingcpp.BarcodeFormat.Code128)
                image.paste(code, (left, top))
                result = barcode_reader.decode_barcode(image)
                self.assertEqual(result["barcode"], "TEST-SERIAL-002")
                self.assertEqual(len(result["barcodes"]), 1)
                points = result["barcodes"][0]["points"]
                self.assertTrue(all(left <= x <= left + code.width for x, _ in points))
                self.assertTrue(all(top <= y <= top + code.height for _, y in points))

    def test_retail_code_is_kept_separate_and_does_not_hide_inventory_code(self):
        image = Image.new("RGB", (2400, 1800), "white")
        image.paste(barcode_image("4713883585477", zxingcpp.BarcodeFormat.EAN13), (100, 100))
        image.paste(barcode_image("TEST-SERIAL-003", zxingcpp.BarcodeFormat.Code128), (1000, 1200))
        result = barcode_reader.decode_barcode(image)
        self.assertEqual(result["barcode"], "TEST-SERIAL-003")
        self.assertEqual({r["value"] for r in result["barcodes"]}, {"TEST-SERIAL-003", "4713883585477"})

    def test_blank_image_retains_existing_no_detection_contract(self):
        result = barcode_reader.decode_barcode(Image.new("RGB", (320, 240), "white"))
        self.assertFalse(result["success"])
        self.assertIsNone(result["barcode"])
        self.assertEqual(result["barcodes"], [])
        self.assertFalse(result["matched"])

    def test_unavailable_native_decoder_keeps_the_opencv_reader(self):
        original = [{"value": "4713883585477", "type": "EAN_13", "points": None}]
        with patch.object(barcode_reader, "zxingcpp", None), patch.object(barcode_reader, "_opencv_candidates", return_value=original) as fallback:
            result = barcode_reader.decode_barcode(Image.new("RGB", (320, 240), "white"))
        fallback.assert_called_once()
        self.assertEqual(result["barcode"], "4713883585477")
        self.assertEqual(result["raw"]["engine"], "opencv")

    def test_native_decoder_failure_uses_opencv_instead_of_failing_the_request(self):
        original = [{"value": "4713883585477", "type": "EAN_13", "points": None}]
        with patch.object(barcode_reader, "_zxing_candidates", side_effect=RuntimeError("decoder unavailable")), patch.object(barcode_reader, "_opencv_candidates", return_value=original):
            with self.assertLogs("ocr-service.barcode", level="WARNING"):
                result = barcode_reader.decode_barcode(Image.new("RGB", (320, 240), "white"))
        self.assertTrue(result["success"])
        self.assertEqual(result["raw"]["engine"], "opencv")


if __name__ == "__main__":
    unittest.main(verbosity=2)
