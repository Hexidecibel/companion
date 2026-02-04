declare module 'react-native-syntax-highlighter' {
  import { ComponentType } from 'react';
  import { ViewStyle } from 'react-native';

  export interface SyntaxHighlighterProps {
    children: string;
    language?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    style?: any;
    highlighter?: 'prism' | 'hljs';
    customStyle?: ViewStyle;
    codeTagProps?: object;
    useInlineStyles?: boolean;
    showLineNumbers?: boolean;
    startingLineNumber?: number;
    lineNumberContainerStyle?: ViewStyle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineNumberStyle?: any;
    wrapLines?: boolean;
    lineProps?: object | ((lineNumber: number) => object);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer?: (props: any) => JSX.Element;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PreTag?: ComponentType<any> | string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CodeTag?: ComponentType<any> | string;
    fontSize?: number;
    fontFamily?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/dist/esm/styles/hljs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const atomOneDark: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const atomOneLight: Record<string, any>;
}
