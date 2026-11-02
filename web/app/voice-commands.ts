export type VoiceCommand = "data" | "review" | "save" | "cancel" | "hold";

// Only explicit, standalone human requests may reach the approval gate.
// Model output never authorizes persistence; mixed recipe data is not approval.
export function voiceCommand(utterance: string): VoiceCommand {
  const clauses=utterance.split(/[。．.!！?？、,\n]+/).map(value=>value.trim()).filter(Boolean);
  if(clauses.length>1){
    const commands=clauses.map(voiceCommand);
    if(commands.every(command=>command!=="data")){
      if(commands.includes("hold"))return "hold";
      if(commands.includes("cancel"))return "cancel";
      return commands.includes("save")?"save":"review";
    }
  }
  const text = utterance.normalize("NFKC").replace(/[\s　、。．.!！?？,]/g, "")
    .replace(/^(?:(?:えー|ええと|えっと|あの|はい)[ー]*)+/, "");
  if (/^(?:キャンセル|破棄|最初から|下書きを破棄|cancel)$/i.test(text)) return "cancel";
  if (/^(?:今は|まだ|今回は|この内容は|内容は)?(?:保存|登録)(?:は)?(?:しない(?:で(?:ください|下さい)?)?|しません|をやめて(?:ください|下さい)?)$/.test(text)) return "hold";
  const review = /^(?:(?:内容|下書き|登録内容)(?:を)?(?:確認|チェック)|確認)(?:して|してください|して下さい|します|をお願いします)?$/;
  if (review.test(text) || /^review$/i.test(text) || /^(?:下書き|内容)(?:を)?見せて(?:ください)?$/.test(text)) return "review";
  const save = (s: string) => {
    const value = s.replace(/^(?:この内容で|この内容を|その内容で|これで|それで|内容を|内容で|この下書きを|下書きを|このレシピを|このレシピで|レシピを|登録内容を)/, "");
    return /^(?:正式登録|本登録|レシピ登録|登録を確定|保存を確定|登録確定|保存確定|登録|保存|確定)(?:してください|して下さい|して|します|する|したい|してほしい|して欲しい|をお願いします|お願いします|をお願いいたします)?$/.test(value) ||
      /^(?:please)?(?:save|register|confirmsave)(?:please)?$/i.test(value);
  };
  if (save(text)) return "save";
  // In speech transcription, brief polite requests may include a leading filler.
  // Reject any recipe-content clause: only a standalone registration intent is actionable.
  if (/^(?:この|その)?(?:レシピ|料理|メニュー)?(?:を|の)?(?:本登録|正式登録|登録|保存)(?:して(?:ください|下さい|ほしい|欲しい)?|したい|をお願いします|お願いします)?$/.test(text)) return "save";
  // A combined request opens review first. It never counts as two approvals.
  const rest = text.replace(/^(?:内容|下書き|登録内容)(?:を)?確認(?:してから|したので|しました|して)?/, "");
  return rest !== text && save(rest) ? "save" : "data";
}
