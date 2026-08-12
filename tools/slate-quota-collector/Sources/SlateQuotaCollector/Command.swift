import Foundation

@main
enum Command {
    static func main() async {
        if CommandLine.arguments.dropFirst().first == "--help" {
            print("slate-quota-collector setup|collect|pause|resume|install-launch-agent|status|uninstall-launch-agent")
            return
        }
        print("尚未选择命令；使用 --help 查看用法")
    }
}
