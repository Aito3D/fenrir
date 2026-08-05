import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SocialInput } from '../../components/aito/SocialInput';

// i18n: follow this file's neighbours (e.g. AitoShippingFields.test.tsx) for
// how the test tree provides translations — reuse the same wrapper/helper.

describe('SocialInput', () => {
  it('shows no handle input until a network is picked', () => {
    render(<SocialInput idPrefix="test" network={null} handle="" onChange={vi.fn()} />);
    expect(screen.queryByLabelText(/username|nom d/i)).not.toBeInTheDocument();
  });

  it('reports the picked network with an empty handle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SocialInput idPrefix="test" network={null} handle="" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Instagram' }));

    expect(onChange).toHaveBeenCalledWith({ network: 'instagram', handle: '' });
  });

  it('reveals the handle input once a network is set', () => {
    render(<SocialInput idPrefix="test" network="instagram" handle="" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Instagram' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('reports handle keystrokes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SocialInput idPrefix="test" network="tiktok" handle="" onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'm');

    expect(onChange).toHaveBeenCalledWith({ network: 'tiktok', handle: 'm' });
  });

  it('clears both fields when the selected network is picked again', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SocialInput idPrefix="test" network="whatsapp" handle="87123456" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'WhatsApp' }));

    expect(onChange).toHaveBeenCalledWith({ network: null, handle: '' });
  });

  it('switches network without losing the typed handle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SocialInput idPrefix="test" network="messenger" handle="moana.fb" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'TikTok' }));

    expect(onChange).toHaveBeenCalledWith({ network: 'tiktok', handle: 'moana.fb' });
  });
});
