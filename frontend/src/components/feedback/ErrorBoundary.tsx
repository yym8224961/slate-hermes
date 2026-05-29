import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  resetErrorBoundary = () => {
    this.setState({ hasError: false, error: null });
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-paper text-ink px-6 py-16">
          <div className="mx-auto max-w-lg border border-line bg-paper p-6">
            <div className="flex items-center gap-3">
              <AlertTriangle size={22} className="text-clay" />
              <h1 className="font-serif text-[26px] font-bold leading-tight">页面加载失败</h1>
            </div>
            <p className="mt-3 font-sans text-[13px] leading-relaxed text-stone">
              当前页面遇到异常，可以先重试渲染；如果仍失败，再刷新应用状态。
            </p>
            {this.state.error?.message && (
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-stone-light break-words">
                {this.state.error.message}
              </p>
            )}
            <div className="mt-6 flex gap-3">
              <Button onClick={this.resetErrorBoundary}>重试</Button>
              <Button variant="outline" onClick={() => window.location.reload()}>
                刷新页面
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
