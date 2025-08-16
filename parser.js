// ---------- Main Component ----------
    function CMemoryVisualizer() {
      const [tab, setTab] = useState("pointers");
      const scenario = useMemo(() => {
        switch (tab) {
          case "pointers":
            return { name: "Pointers & malloc/free", code: codePointers, steps: scriptPointers() };
          case "recursion":
            return { name: "Functions & Recursion", code: codeRecursion, steps: scriptRecursion() };
          case "arrays":
            return { name: "Arrays & Strings (Coming Soon)", code: "// Coming next: arrays, strings, pointer arithmetic", steps: [ { lines: [], desc: "মডিউল প্রস্তুত হচ্ছে…", stack: [], heap: [], stdout: "" } ] };
          case "structs":
            return { name: "Structs & Pointer-to-Struct (Coming Soon)", code: "// Coming next: struct, -> operator, nested structs", steps: [ { lines: [], desc: "মডিউল প্রস্তুত হচ্ছে…", stack: [], heap: [], stdout: "" } ] };
          case "files":
            return { name: "File I/O (Simulated) (Coming Soon)", code: "// Coming next: fopen, fread/fwrite, fclose (simulated)", steps: [ { lines: [], desc: "মডিউল প্রস্তুত হচ্ছে…", stack: [], heap: [], stdout: "" } ] };
          default:
            return { name: "", code: "", steps: [] };
        }
      }, [tab]);

      const [i, setI] = useState(0);
      const step = scenario.steps[i] ?? scenario.steps[scenario.steps.length - 1];
      const max = scenario.steps.length - 1;
      const [auto, setAuto] = useState(false);
      const timer = useRef(null);

      useEffect(() => { setI(0); setAuto(false); }, [tab]);
      useEffect(() => {
        if (!auto) return;
        timer.current = setTimeout(() => setI(prev => Math.min(prev + 1, max)), 1100);
        return () => clearTimeout(timer.current);
      }, [auto, i, max]);
