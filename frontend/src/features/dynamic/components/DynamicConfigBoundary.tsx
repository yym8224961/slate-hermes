import { Component, type ErrorInfo, type ReactNode } from 'react';

export class DynamicConfigBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[DynamicConfigForm]', error, info.componentStack);
  }

  componentDidUpdate(prevProps: { resetKey: string }): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <p className="font-sans text-[12px] leading-relaxed text-clay">
          配置加载异常，请返回后重试。
        </p>
      );
    }
    return this.props.children;
  }
}
