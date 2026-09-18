import React, { Component, type ReactNode } from 'react';
import { ThinkingOrb, type OrbState, type OrbSize, type OrbTheme } from 'thinking-orbs';

export interface SafeThinkingOrbProps {
  state?: OrbState;
  size?: OrbSize;
  theme?: OrbTheme;
  speed?: number;
  paused?: boolean;
  style?: React.CSSProperties;
  fallback?: ReactNode;
  role?: string;
  className?: string;
}

interface SafeThinkingOrbState {
  hasError: boolean;
}

export class SafeThinkingOrb extends Component<SafeThinkingOrbProps, SafeThinkingOrbState> {
  constructor(props: SafeThinkingOrbProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): SafeThinkingOrbState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.warn('ThinkingOrb render failure handled gracefully:', error.message);
  }

  render(): ReactNode {
    const size = this.props.size === 20 ? 20 : 64;

    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <span
          className="safe-orb-fallback"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(16,185,129,0.2) 0%, rgba(16,185,129,0.05) 70%)',
            border: '1px solid rgba(16,185,129,0.3)',
            fontSize: size === 20 ? '0.75rem' : '1.5rem',
            ...this.props.style,
          }}
          role={this.props.role ?? 'presentation'}
        >
          ✦
        </span>
      );
    }

    return (
      <ThinkingOrb
        state={this.props.state}
        size={size}
        theme={this.props.theme}
        speed={this.props.speed}
        paused={this.props.paused}
        style={this.props.style}
        role={this.props.role}
        className={this.props.className}
      />
    );
  }
}
