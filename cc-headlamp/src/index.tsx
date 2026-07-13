/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// import { registerAppBarAction } from '@kinvolk/headlamp-plugin/lib';

import { registerAppTheme, AppLogoProps, registerAppLogo } from '@kinvolk/headlamp-plugin/lib';

registerAppTheme({
  name: 'Cumulus',
  base: 'light',
  primary: '#ff3552',
  secondary: '#f9e79f',

  background: {
    default: '#fafafa',
    surface: '#ffffff',
    muted: '#fdf6e3',
  },
  navbar: {
    background: '#555555',
    color: '#f1f8e9',
  },
  sidebar: {
    background: '#555555',
    color: '#ffffff',
    selectedBackground: 'rgba(0, 0, 0, 0.2)',
    selectedColor: '#ffffff',
    actionBackground: '#0d1b2a',
  },
  radius: 5,
  buttonTextTransform: 'none',
});

function CommunityCloudLogo({ logoType }: AppLogoProps) {
  if (logoType === 'small') {
    return <span>☁️</span>;
  } else {
    return (
      <img
        height="32px"
        src="https://community-cloud.technology/cloud-logo-color.png"
        alt="Community Cloud"
      />
    );
  }
}

registerAppLogo(CommunityCloudLogo);

// Below are some imports you may want to use.
//   See README.md for links to plugin development documentation.
// import { Headlamp, K8s, useTranslation } from '@kinvolk/headlamp-plugin/lib';
// import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
// import { K8s } from '@kinvolk/headlamp-plugin/lib/K8s';
// import { Typography } from '@mui/material';

// registerAppBarAction(<span>Hello!</span>);

// Example of using i18n (internationalization):
// function MyComponent() {
//   const { t } = useTranslation();
//   return <div>{t('translation_key')}</div>;
// }
