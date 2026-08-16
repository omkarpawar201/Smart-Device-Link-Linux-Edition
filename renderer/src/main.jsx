import React, { Component } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProvider } from './appStore';

import './styles/styles.css';

window.addEventListener('error', (e) => {
    console.error('[renderer] uncaught error:', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[renderer] unhandled rejection:', e.reason);
});

class ErrorBoundary extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        console.error('[renderer] React error boundary:', error, info.componentStack);
    }
    render() {
        if (this.state.error) {
            return (
                <div style={{ padding: 24, fontFamily: 'Segoe UI, sans-serif', fontSize: 14 }}>
                    <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
                    <pre style={{ whiteSpace: 'pre-wrap', color: '#f87171' }}>
                        {String(this.state.error && (this.state.error.message || this.state.error))}
                    </pre>
                    <button onClick={() => this.setState({ error: null })}>Dismiss</button>
                </div>
            );
        }
        return this.props.children;
    }
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ErrorBoundary>
            <AppProvider>
                <App />
            </AppProvider>
        </ErrorBoundary>
    </React.StrictMode>
);
