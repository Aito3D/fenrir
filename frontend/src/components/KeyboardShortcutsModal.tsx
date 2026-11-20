import { useEffect } from 'react';
import { X, Keyboard } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Card, CardContent } from './Card';

interface KeyboardShortcutsModalProps {
  onClose: () => void;
}

/** No Navigation section: the 1-9 sidebar shortcuts were removed from Layout
 *  (they fired while typing numbers into non-native fields). No C camera key
 *  either: the fork keeps cameras on the Printers page. */
function getShortcuts(t: (key: string) => string) {
  return [
    { category: t('keyboardShortcuts.archivesSection'), items: [
      { keys: ['/'], description: t('keyboardShortcuts.shortcuts.focusSearch') },
      { keys: ['U'], description: t('keyboardShortcuts.shortcuts.openUploadModal') },
      { keys: ['Esc'], description: t('keyboardShortcuts.shortcuts.clearSelection') },
      { keys: [t('keyboardShortcuts.rightClick')], description: t('keyboardShortcuts.shortcuts.contextMenu') },
    ]},
    { category: t('keyboardShortcuts.kProfilesSection'), items: [
      { keys: ['R'], description: t('keyboardShortcuts.shortcuts.refreshProfiles') },
      { keys: ['N'], description: t('keyboardShortcuts.shortcuts.newProfile') },
      { keys: ['Esc'], description: t('keyboardShortcuts.shortcuts.exitSelectionMode') },
    ]},
    { category: t('keyboardShortcuts.generalSection'), items: [
      { keys: ['?'], description: t('keyboardShortcuts.shortcuts.showHelp') },
    ]},
  ];
}

function KeyBadge({ children }: { children: string }) {
  return (
    <kbd className="px-2 py-1 text-xs font-mono bg-bambu-dark border border-bambu-dark-tertiary rounded text-white">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
  const { t } = useTranslation();
  const shortcuts = getShortcuts(t);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-overlay-in" onClick={onClose}>
      <Card className="w-full max-w-md animate-modal-in" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-0">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
            <div className="flex items-center gap-2">
              <Keyboard className="w-5 h-5 text-bambu-green" />
              <h2 className="text-xl font-semibold text-white">{t('keyboardShortcuts.title')}</h2>
            </div>
            <button
              onClick={onClose}
              className="text-bambu-gray hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Shortcuts List */}
          <div className="p-4 space-y-6 max-h-[60vh] overflow-y-auto">
            {shortcuts.map((section) => (
              <div key={section.category}>
                <h3 className="text-sm font-medium text-bambu-gray mb-3">{section.category}</h3>
                <div className="space-y-2">
                  {section.items.map((shortcut) => (
                    <div key={shortcut.description} className="flex items-center justify-between">
                      <span className="text-white text-sm">{shortcut.description}</span>
                      <div className="flex gap-1">
                        {shortcut.keys.map((key) => (
                          <KeyBadge key={key}>{key}</KeyBadge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-bambu-dark-tertiary">
            <p className="text-xs text-bambu-gray text-center">
              <Trans
                i18nKey="keyboardShortcuts.footerWithKey"
                components={{
                  kbd: <kbd className="px-2 py-1 text-xs font-mono bg-bambu-dark border border-bambu-dark-tertiary rounded text-white" />,
                }}
              />
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
