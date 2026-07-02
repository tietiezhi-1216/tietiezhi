//  UsageStatsView.swift
//  模型服务 › 用量: accumulated cost + token/audio usage across chat, ASR, and
//  polish, derived entirely from the append-only UsageStore. Cost per record is
//  frozen at call time from the model's effective pricing.

import SwiftUI

struct UsageStatsView: View {
    @EnvironmentObject var usage: UsageStore

    var body: some View {
        PageScaffold(title: "模型服务 · 用量") {
            Form {
                Section {
                    if usage.records.isEmpty {
                        Text("还没有用量记录。发起一次对话或听写后，这里会累计 token / 时长与花费。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                            ForEach(usage.totalCostByCurrency, id: \.currency) { item in
                                statCard("总花费（\(item.currency)）",
                                         "\(symbol(item.currency))\(money(item.cost))", "creditcard")
                            }
                            statCard("调用次数", "\(usage.records.count)", "number")
                            statCard("输入 tokens", compact(usage.totalInputTokens), "arrow.down.circle")
                            statCard("输出 tokens", compact(usage.totalOutputTokens), "arrow.up.circle")
                        }
                        .padding(.vertical, 4)
                    }
                } header: {
                    HStack {
                        Text("概览")
                        Spacer()
                        if !usage.records.isEmpty {
                            Button(role: .destructive) { usage.clear() } label: {
                                Label("清空", systemImage: "trash")
                            }
                            .buttonStyle(.borderless).controlSize(.small)
                        }
                    }
                } footer: {
                    Text("价格为系统内置默认值（可能与实际计费有偏差），可在「模型」里按模型覆盖。无价模型不计入花费。")
                }

                if !usage.records.isEmpty {
                    Section("按模型") {
                        ForEach(usage.breakdownByModel(), id: \.label) { row in
                            HStack {
                                Text(row.label).font(.callout).lineLimit(1)
                                Spacer()
                                Text("\(row.count) 次").font(.caption).foregroundStyle(.secondary)
                                Text(row.cost > 0 ? "\(symbol(row.currency))\(money(row.cost))" : "—")
                                    .font(.callout.monospacedDigit())
                                    .frame(width: 90, alignment: .trailing)
                            }
                        }
                    }

                    Section("按用途") {
                        ForEach(usage.breakdownBySource(), id: \.source) { row in
                            HStack {
                                Text(sourceName(row.source)).font(.callout)
                                Spacer()
                                Text("\(row.count) 次").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private func statCard(_ title: String, _ value: String, _ symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 18)).foregroundStyle(Color.accentColor).frame(width: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(value).font(.system(size: 20, weight: .semibold, design: .rounded))
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func sourceName(_ s: String) -> String {
        switch s {
        case "chat":   return "对话"
        case "asr":    return "语音识别"
        case "polish": return "听写润色"
        default:       return s
        }
    }

    private func symbol(_ currency: String) -> String {
        switch currency.uppercased() {
        case "CNY", "RMB": return "¥"
        case "USD":        return "$"
        default:           return currency.isEmpty ? "" : currency + " "
        }
    }

    private func money(_ v: Double) -> String {
        String(format: v < 1 ? "%.4f" : "%.2f", v)
    }

    private func compact(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }
}
