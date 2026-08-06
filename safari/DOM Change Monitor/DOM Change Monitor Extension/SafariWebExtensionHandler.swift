//
//  SafariWebExtensionHandler.swift
//  DOM Change Monitor Extension
//
//  Created by Jacob Reiff on 8/6/26.
//

import SafariServices
import AppKit
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        var reply: [String: Any] = ["ok": false]
        if let dict = message as? [String: Any], dict["type"] as? String == "notify" {
            reply["ok"] = forwardNotification(dict)
        } else {
            os_log(.default, "Unhandled native message: %@", String(describing: message))
        }

        let response = NSExtensionItem()
        if #available(macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    // Hand the notification to the container app via its URL scheme. The appex
    // could post a banner itself, but clicks on appex-posted notifications go
    // nowhere (the system cannot launch an appex), so the app is the poster.
    private func forwardNotification(_ dict: [String: Any]) -> Bool {
        var components = URLComponents()
        components.scheme = "dom-change-monitor"
        components.host = "notify"
        components.queryItems = ["id", "title", "message", "url"].compactMap { key in
            (dict[key] as? String).map { URLQueryItem(name: key, value: $0) }
        }
        guard let url = components.url else { return false }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        NSWorkspace.shared.open(url, configuration: configuration, completionHandler: nil)
        return true
    }

}
