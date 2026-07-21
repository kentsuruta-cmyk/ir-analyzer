export const metadata = {
  title: "IR分析ツール",
  description: "企業のIR資料を自動収集してAIが分析します",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
