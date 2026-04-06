import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

function getSendButton() {
  return screen.getByRole('button', { name: /send/i });
}

test('renders sidebar settings and chat composer', () => {
  render(<App />);

  expect(screen.getByText(/AI Code Assistant/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Settings sidebar/i)).toBeInTheDocument();

  expect(screen.getByLabelText(/Provider type/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Model identifier/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Temperature/i)).toBeInTheDocument();

  expect(screen.getByLabelText(/Message input/i)).toBeInTheDocument();
  expect(getSendButton()).toBeInTheDocument();
});

test('sending a message appends a user message to the transcript', () => {
  render(<App />);

  const input = screen.getByLabelText(/Message input/i);
  fireEvent.change(input, { target: { value: 'Hello from test' } });

  fireEvent.click(getSendButton());

  // Should render a user message bubble
  expect(screen.getByText('Hello from test')).toBeInTheDocument();
  expect(screen.getAllByTestId('msg-user').length).toBeGreaterThanOrEqual(1);
});

test('logs modal opens and shows placeholder when empty', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /logs/i }));
  expect(screen.getByRole('dialog', { name: /logs/i })).toBeInTheDocument();
  expect(screen.getByText(/No logs yet/i)).toBeInTheDocument();
});
