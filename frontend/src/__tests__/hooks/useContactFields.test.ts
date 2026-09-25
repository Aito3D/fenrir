import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useContactFields } from '../../components/aito/useContactFields';

describe('useContactFields', () => {
  it('normalises the names on blur, not on every keystroke', () => {
    const { result } = renderHook(() => useContactFields());

    act(() => result.current.onFirstNameChange('jean-pierre'));
    act(() => result.current.onLastNameChange('dupont'));
    // Raw while typing — casing must not fight a hyphenated name mid-entry.
    expect(result.current.firstName).toBe('jean-pierre');
    expect(result.current.lastName).toBe('dupont');
    // ...but the cased preview is live.
    expect(result.current.casedFirst).toBe('Jean-Pierre');
    expect(result.current.casedLast).toBe('DUPONT');

    act(() => result.current.onFirstNameBlur('jean-pierre'));
    act(() => result.current.onLastNameBlur('dupont'));
    expect(result.current.firstName).toBe('Jean-Pierre');
    expect(result.current.lastName).toBe('DUPONT');
  });

  it('masks a field error until the field has been left once', () => {
    const { result } = renderHook(() => useContactFields());

    act(() => result.current.onEmailChange('not-an-email'));
    expect(result.current.emailError).not.toBeNull();
    expect(result.current.visibleErrors.email).toBeNull();
    expect(result.current.errorsClear).toBe(true);

    act(() => result.current.onEmailBlur());
    expect(result.current.visibleErrors.email).toBe(result.current.emailError);
    expect(result.current.errorsClear).toBe(false);
  });

  it('reveals a country-code error at once but waits for the blur on a number', () => {
    const { result } = renderHook(() => useContactFields());

    act(() => result.current.onPhoneChange({ countryCode: '+689', nationalNumber: '12' }, 'nationalNumber'));
    expect(result.current.phoneError).not.toBeNull();
    expect(result.current.visibleErrors.phone).toBeNull();

    act(() => result.current.onPhoneChange({ countryCode: '+33', nationalNumber: '12' }, 'countryCode'));
    expect(result.current.visibleErrors.phone).toBe(result.current.phoneError);
  });

  it('is reachable on either channel alone, and revealErrors unmasks both', () => {
    const { result } = renderHook(() => useContactFields());
    expect(result.current.reachable).toBe(false);

    act(() => result.current.onEmailChange('a@b.test'));
    expect(result.current.reachable).toBe(true);

    act(() => result.current.onEmailChange(''));
    act(() => result.current.onPhoneChange({ countryCode: '+689', nationalNumber: '87123456' }, 'nationalNumber'));
    expect(result.current.reachable).toBe(true);

    act(() => result.current.onEmailChange('nope'));
    expect(result.current.errorsClear).toBe(true);
    act(() => result.current.revealErrors());
    expect(result.current.errorsClear).toBe(false);
    expect(result.current.visibleErrors.email).not.toBeNull();
  });

  it('fires onFieldChange for every capture field, and never without the option', () => {
    const onFieldChange = vi.fn();
    const { result } = renderHook(() => useContactFields({ onFieldChange }));

    act(() => result.current.onFirstNameChange('a'));
    act(() => result.current.onLastNameChange('b'));
    act(() => result.current.onEmailChange('c'));
    act(() => result.current.onPhoneChange({ countryCode: '+689', nationalNumber: '8' }, 'nationalNumber'));
    expect(onFieldChange).toHaveBeenCalledTimes(4);

    // Blurs are not keystrokes.
    onFieldChange.mockClear();
    act(() => result.current.onFirstNameBlur('a'));
    act(() => result.current.onEmailBlur());
    act(() => result.current.onPhoneBlur());
    expect(onFieldChange).not.toHaveBeenCalled();

    // The option is optional: the other call site opts out entirely.
    const bare = renderHook(() => useContactFields());
    expect(() => act(() => bare.result.current.onFirstNameChange('x'))).not.toThrow();
    expect(bare.result.current.firstName).toBe('x');
  });
});
