//  OCRService.swift
//  Local text recognition over a captured region via the Vision framework —
//  no network, no cost. Feeds two consumers: the 提取文字 toolbar action (join
//  the lines, copy) and the AI annotator (each line's bounding box becomes a
//  coordinate anchor the vision model can aim at).

import Foundation
import Vision

/// One recognized line. `rect` is in the crop's POINT coordinates (top-left
/// origin, y down) — the same space annotations live in.
struct OCRLine {
    let text: String
    let rect: CGRect
}

enum OCRService {

    /// Recognize text in a cropped CGImage. `pointSize` is the crop's size in
    /// points (Vision reports normalized bottom-left boxes; we convert).
    static func recognize(in image: CGImage, pointSize: CGSize) async throws -> [OCRLine] {
        try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: OrbitError("文字识别失败：\(error.localizedDescription)"))
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let lines: [OCRLine] = observations.compactMap { obs in
                    guard let candidate = obs.topCandidates(1).first else { return nil }
                    let b = obs.boundingBox   // normalized, bottom-left origin
                    let rect = CGRect(x: b.minX * pointSize.width,
                                      y: (1 - b.maxY) * pointSize.height,
                                      width: b.width * pointSize.width,
                                      height: b.height * pointSize.height)
                    return OCRLine(text: candidate.string, rect: rect)
                }
                continuation.resume(returning: lines)
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
            request.usesLanguageCorrection = true

            DispatchQueue.global(qos: .userInitiated).async {
                let handler = VNImageRequestHandler(cgImage: image, options: [:])
                do {
                    try handler.perform([request])
                } catch {
                    continuation.resume(throwing: OrbitError("文字识别失败：\(error.localizedDescription)"))
                }
            }
        }
    }

    /// Reading-order plain text (top-to-bottom, then left-to-right).
    static func joined(_ lines: [OCRLine]) -> String {
        lines.sorted {
            abs($0.rect.midY - $1.rect.midY) > 8 ? $0.rect.midY < $1.rect.midY
                                                 : $0.rect.minX < $1.rect.minX
        }
        .map(\.text)
        .joined(separator: "\n")
    }
}
