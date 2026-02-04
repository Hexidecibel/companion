import { useState, useEffect } from 'react';
import { fontScaleService } from '../services/fontScale';

export function useFontScale(): number {
  const [scale, setScale] = useState(fontScaleService.getScale());

  useEffect(() => {
    // Sync in case it loaded after initial render
    setScale(fontScaleService.getScale());
    return fontScaleService.subscribe(setScale);
  }, []);

  return scale;
}
