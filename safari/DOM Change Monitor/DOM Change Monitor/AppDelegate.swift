//
//  AppDelegate.swift
//  DOM Change Monitor
//
//  Created by Jacob Reiff on 8/6/26.
//

import Cocoa
import UserNotifications

@main
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    // Set once this launch is acting as the notification agent (launched via
    // the dom-change-monitor:// scheme or a notification click). Keeps the app
    // resident with no windows so later notifications are handled instantly.
    private var isNotificationAgent = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Must be set before launch finishes so a notification click that
        // cold-starts the app still reaches didReceive.
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        if isNotificationAgent {
            NSApp.windows.forEach { $0.orderOut(nil) }
        } else {
            // LSUIElement apps don't activate on their own; bring the
            // enable-in-Safari window forward for a normal launch.
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "dom-change-monitor" && url.host == "notify" {
            isNotificationAgent = true
            NSApp.windows.forEach { $0.orderOut(nil) }
            postNotification(from: url)
        }
    }

    private func postNotification(from url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        func param(_ name: String) -> String? {
            components.queryItems?.first(where: { $0.name == name })?.value
        }

        let content = UNMutableNotificationContent()
        content.title = param("title") ?? "DOM Change Monitor"
        content.body = param("message") ?? ""
        content.sound = .default
        if let target = param("url") {
            content.userInfo = ["url": target]
        }

        let request = UNNotificationRequest(identifier: param("id") ?? UUID().uuidString,
                                            content: content,
                                            trigger: nil)
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in
            center.add(request)
        }
    }

    // Show banners even when the agent app is frontmost.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    // Notification clicked: open the monitored page in Safari.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        isNotificationAgent = true
        NSApp.windows.forEach { $0.orderOut(nil) }

        if let target = response.notification.request.content.userInfo["url"] as? String,
           let url = URL(string: target) {
            if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
                NSWorkspace.shared.open([url], withApplicationAt: safari,
                                        configuration: NSWorkspace.OpenConfiguration())
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        completionHandler()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return !isNotificationAgent
    }

}
